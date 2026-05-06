const { execSync } = require('child_process');
for (const cmd of ['ffmpeg -version','where ffmpeg']) {
  try { console.log('CMD', cmd); console.log(execSync(cmd,{stdio:'pipe'}).toString()); }
  catch(e){ console.log('FAIL', cmd); console.log((e.stdout||'').toString()); console.log((e.stderr||'').toString()); }
}
