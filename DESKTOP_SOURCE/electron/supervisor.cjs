// Own the native child independently, including after an Electron crash.
const { spawn } = require('node:child_process');
const [engine, cwd] = process.argv.slice(2);
let child, stopping=false;
const report=state => process.stderr.write(JSON.stringify(state)+'\n');
function stop() {
  if(stopping) return; stopping=true;
  if(!child?.pid || child.exitCode!==null) return process.exit(0);
  const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  killer.on('error',()=>{child.kill();process.exit(1)}); killer.on('exit',code=>process.exit(code===0?0:1));
}
const ownerPID=process.ppid;
setInterval(()=>{try{process.kill(ownerPID,0)}catch{stop()}},250);
process.stdin.on('end',stop); process.stdin.on('error',stop); process.stdout.on('error',stop); process.stderr.on('error',stop); process.on('SIGTERM',stop);
child=spawn(engine,['--internal-pipe'],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
child.stdin.on('error',()=>{});
child.stderr.on('data',chunk=>report({log:chunk.toString('base64')}));
child.on('spawn',()=>report({pid:child.pid}));
child.on('error',error=>{report({error:error.message});process.exit(1)});
child.on('exit',code=>{if(!stopping){report({error:'Medusa stopped (code '+code+').'});process.exit(code||0)}});
