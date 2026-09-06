"""Browser integration tests. No app packages are needed.

Install test tooling separately: pip install playwright; playwright install chromium.
CHROMIUM_PATH optionally selects a system browser. FORGE_URL optionally selects
an HTTP(S) deployment; otherwise test the bundled HTML by offline DOM injection.
The offline mode intentionally cannot test secure-context WebGPU or IndexedDB.
"""
import asyncio, json, os, zipfile
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
RESULTS = []
def check(name, condition, detail=None):
    RESULTS.append({'name':name,'passed':bool(condition),**({'detail':detail} if detail else {})})
    print(('PASS' if condition else 'FAIL')+' '+name, flush=True)
    assert condition, name + ': ' + str(detail)

async def main():
  async with async_playwright() as p:
    opts={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
    if os.environ.get('CHROMIUM_PATH'):opts['executable_path']=os.environ['CHROMIUM_PATH']
    browser=await p.chromium.launch(**opts)
    page=await browser.new_page(viewport={'width':1600,'height':1000},accept_downloads=True)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    if os.environ.get('FORGE_URL'):await page.goto(os.environ['FORGE_URL'])
    else:await page.set_content((ROOT/'ForgeStudio.html').read_text())
    await page.wait_for_function("document.documentElement.dataset.ready==='true'")
    async def state(js):return await page.evaluate(js)
    async def command(name):await page.evaluate('(name)=>forge.execute(name)',name)
    check('Workspace boot: fourteen real files',await state('forge.workspace.files.size===14'))
    check('Initial worker diagnostics and C# symbols',await state('forge.workspace.active.diagnostics.length===0 && forge.workspace.active.symbols.length>0'))
    await command('build')
    check('JavaScript / JSON validation succeeds',await page.locator('#status-message').inner_text()=='Validation passed')
    # New file, through the actual dialog and key-input pipeline.
    await page.keyboard.press('Control+n');await page.locator('#dialog-input').fill('scratch.js');await page.locator('#dialog-input').press('Enter')
    await page.wait_for_function("forge.workspace.activePath==='scratch.js'")
    await page.keyboard.insert_text('const answer = 42;\nconsole.log(answer);')
    check('Native beforeinput edits the piece table',await state("forge.workspace.active.text==='const answer = 42;\\nconsole.log(answer);'"))
    await page.keyboard.press('Control+z');check('Keyboard undo',await state("forge.workspace.active.text===''"))
    await page.keyboard.press('Control+Shift+z');check('Keyboard redo',await state("forge.workspace.active.text.includes('answer = 42')"))
    await command('find');await page.locator('#find-input').fill('answer');await page.locator('#replace-input').fill('result');await command('replaceAll')
    check('Replace all updates source transactionally',await state("forge.workspace.active.text==='const result = 42;\\nconsole.log(result);'"))
    await command('closeFind');await command('undo');check('Replace-all undo is one operation',await state("forge.workspace.active.text.includes('answer = 42')"))
    # Pair insertion and deletion, then restore.
    await command('selectAll');await page.keyboard.press('Backspace');await page.keyboard.insert_text('(')
    check('Auto-pair insertion',await state("forge.workspace.active.text==='()' && forge.workspace.active.selection.head===1"))
    await page.keyboard.press('Backspace');check('Paired backspace',await state("forge.workspace.active.text===''"))
    await page.keyboard.insert_text('a👩‍💻b');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Backspace')
    check('Deletion respects extended grapheme clusters',await state("forge.workspace.active.text==='ab'"))
    # Accessible mode uses a real DOM textarea without bypassing the document.
    await command('accessible');await page.locator('.accessible-editor').fill('const accessible = 10;')
    check('Accessible editor writes through document model',await state("forge.workspace.active.text==='const accessible = 10;'"))
    await command('accessible')
    # Completion is deliberately lexical rather than a fake language server.
    await command('selectAll');await page.keyboard.insert_text('con');await page.keyboard.press('Control+Space')
    check('Completion popup has actual candidates',await page.locator('.suggestions [role=option]').count()>0)
    await page.keyboard.press('Escape')
    await command('selectAll');await page.keyboard.insert_text('const = ;');await state('forge.analysis.analyze(forge.workspace.active)')
    check('Worker reports malformed JavaScript',await state('forge.workspace.active.diagnostics.length>0'))
    await command('selectAll');await page.keyboard.insert_text('console.log("integration-runtime-ok");')
    await state('forge.analysis.analyze(forge.workspace.active)')
    check('Diagnostics clear after a valid edit',await state('forge.workspace.active.diagnostics.length===0'))
    await command('runFile');await page.wait_for_function("document.querySelector('#output-lines').textContent.includes('integration-runtime-ok')")
    await page.wait_for_function('forge.runtime.sessions.size===0')
    check('JavaScript runs in isolated worker',True)
    # Quick file selection is a keyboard-driven UI path.
    await page.keyboard.press('Control+p');await page.locator('#palette-input').fill('diagnostics.js');await page.locator('#palette-input').press('Enter')
    check('Quick open selects the matching workspace document',await state("forge.workspace.activePath==='scripts/diagnostics.js'"))
    await command('trace');await page.wait_for_function("[...forge.runtime.sessions.values()].some(s=>s.mode==='trace'&&s.paused)")
    check('Trace pauses at a real source checkpoint',await state('forge.editor.executionLine>=0'))
    await command('step');await page.wait_for_function("document.querySelector('#locals-list').textContent.includes('Nebula')")
    check('Step exposes initialized top-level locals',True)
    await command('continue');await page.wait_for_function('forge.runtime.sessions.size===0')
    check('Continue completes the trace worker',True)
    # Delete scratch directly through the workspace API, then run the bundled suite.
    await state("forge.workspace.delete('scratch.js')")
    await command('runTests');await page.wait_for_function("document.querySelector('#test-summary').textContent.includes('7 passed')")
    check('Seven demo module tests really execute',await page.locator('.test-result').count()==7 and await page.locator('.test-result.failed').count()==0)
    # Real export; verify ZIP using an independent implementation.
    async with page.expect_download() as info:await command('exportZip')
    download=await info.value;dest=ROOT/'docs'/'test-export.zip';await download.save_as(dest)
    with zipfile.ZipFile(dest) as archive:
      check('Project ZIP export has valid CRCs and files',archive.testzip() is None and len(archive.namelist())==14)
    dest.unlink()
    async with page.expect_download() as info:await command('exportWorkspace')
    download=await info.value;dest=ROOT/'docs'/'test-workspace.json';await download.save_as(dest)
    data=json.loads(dest.read_text());check('Portable workspace backup preserves document data',data['format']=='forge-workspace' and len(data['files'])==14);dest.unlink()
    # Return to showcase document. Screenshots contain actual tested output.
    await state("forge.workspace.open('Nebula.Core/Rendering/ParticleSystem.cs');forge.editor.goto(0)")
    await page.wait_for_timeout(6700) # let expected offline storage notification expire
    await page.screenshot(path=str(ROOT/'docs'/'screenshot-dark.png'))
    await command('runPreview');await page.wait_for_function("document.querySelector('#output-lines').textContent.includes('Nebula is running')")
    preview=page.frame_locator('#preview-frame');await preview.locator('#toggle').click()
    check('Sandboxed preview loads local modules and handles input','Resume' in await preview.locator('#toggle').inner_text())
    await preview.locator('#count').fill('1024');await preview.locator('#count').dispatch_event('input')
    check('Preview updates live particle parameters','1,024' in await preview.locator('#count-label').inner_text())
    await state("forge.workspace.open('Nebula.Web/src/app.js');forge.editor.goto(0)")
    await page.screenshot(path=str(ROOT/'docs'/'screenshot-preview.png'))
    await command('stop');check('Stop disposes all execution sessions',await state('forge.runtime.sessions.size===0'))
    await command('togglePreview');await command('toggleTheme');await command('tests')
    check('Light theme switches the actual editor palette',await state("document.documentElement.dataset.theme==='light' && forge.editor.options.theme==='light'"))
    await page.wait_for_timeout(6700);await page.screenshot(path=str(ROOT/'docs'/'screenshot-light.png'))
    check('No uncaught browser exceptions',not errors,errors)
    capabilities=await state("({renderer:forge.editor.surface.mode,secureContext:isSecureContext,webgpuAvailable:!!navigator.gpu,persistentStorage:!!forge.workspace.storage})")
    (ROOT/'docs'/'browser-test-results.json').write_text(json.dumps({'environment':'HTTP deployment' if os.environ.get('FORGE_URL') else 'offline DOM injection (opaque origin)','capabilities':capabilities,'browser':browser.version,'checks':RESULTS},indent=2))
    print(json.dumps(capabilities));print(f'{len(RESULTS)} browser integration checks passed.');await browser.close()

asyncio.run(main())
