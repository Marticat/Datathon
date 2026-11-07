import { createApp } from './app.mjs';
const port=Number(process.env.PORT||3000);const app=createApp();
app.server.listen(port,'127.0.0.1',()=>{console.log(`CQA: http://127.0.0.1:${port}`);void app.resume();});
app.server.on('error',error=>{console.error(error.message);process.exitCode=1;});
