export function findMatches(text, query, {regex=false,caseSensitive=false,wholeWord=false,limit=10000}={}) {
  if(!query)return [];
  const pattern=regex?query:query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // Explicitly reject patterns with obvious nested repetition. This is not a
  // complete ReDoS defense; interactive regex search is additionally size-limited.
  if(regex&&(/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)||text.length>300000))throw new Error('Use a simpler expression or a smaller file for regex search.');
  const re=new RegExp(wholeWord?`\\b(?:${pattern})\\b`:pattern,`g${caseSensitive?'':'i'}u`);
  const result=[];let match;
  while((match=re.exec(text))&&result.length<limit){result.push({start:match.index,end:match.index+match[0].length,match:[...match]});if(!match[0].length)re.lastIndex+=text.codePointAt(re.lastIndex)>0xffff?2:1;}
  return result;
}
export function lineDiff(before,after,maxCells=1000000){
  const a=before.split('\n'),b=after.split('\n');
  if(a.length*b.length>maxCells){return [...a.map((text,index)=>({kind:'removed',oldLine:index+1,text})),...b.map((text,index)=>({kind:'added',newLine:index+1,text}))];}
  const cols=b.length+1,dp=new Uint32Array((a.length+1)*cols);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*cols+j]=a[i]===b[j]?1+dp[(i+1)*cols+j+1]:Math.max(dp[(i+1)*cols+j],dp[i*cols+j+1]);
  const out=[];let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){out.push({kind:'same',oldLine:i+1,newLine:j+1,text:a[i]});i++;j++;}
    else if(j<b.length&&(i===a.length||dp[i*cols+j+1]>=dp[(i+1)*cols+j]))out.push({kind:'added',newLine:++j,text:b[j-1]});
    else out.push({kind:'removed',oldLine:++i,text:a[i-1]});
  }return out;
}
