import {spawn} from 'node:child_process';
if(!process.stdin.isTTY)throw new Error('请使用交互终端输入维护密码');
process.stdout.write('本地维护密码（输入不回显）：');
process.stdin.setRawMode(true);process.stdin.resume();
let password='';
process.stdin.on('data',data=>{
  for(const character of data.toString()){
    if(character==='\u0003'){process.stdin.setRawMode(false);process.exit(130);}
    if(character==='\r'||character==='\n'){
      process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');
      const child=spawn('npx',['playwright','test','qa-v2-local-connection.spec.ts','--workers=1','--reporter=dot'],{stdio:['ignore','inherit','inherit'],env:{...process.env,YPBI_LOCAL_INTEGRATION:'true',YPBI_LOCAL_MAINTENANCE_PASSWORD:password}});
      password='';child.on('exit',code=>process.exit(code??1));return;
    }
    if(character==='\u007f')password=password.slice(0,-1);else password+=character;
  }
});
