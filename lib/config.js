const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.commierc');

const rl=readline.createInterface({
            input:process.stdin,
            output:process.stdout
        });
const askQuestion=(query)=>new Promise((resolve)=>rl.question(query,resolve))



async function getConfig(){
    if(!fs.existsSync(configPath)){
        console.log("Please Enter your api key");
        const answer=await askQuestion("Paste it here: ");
        rl.close()
           const config = {
            provider: 'groq',
            apiKey: answer,
            model: 'llama-3.3-70b-versatile',
            baseUrl: 'https://api.groq.com/openai'
        };
        fs.writeFileSync(configPath,JSON.stringify(config, null,2))
        return config
    }
    else {
    rl.close(); 
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
    }
}

module.exports = { getConfig };