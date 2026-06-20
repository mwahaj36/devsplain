const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve))

/**
 * Retrieves the configuration for the application.
 * If the configuration file does not exist, it will prompt the user to create one.
 * @returns {Promise<Object>} The configuration object.
 */
async function getConfig() {
  if (!fs.existsSync(configPath)) {
    let baseUrl = "";
    let model = "";
    let provider = "";
    console.log("Which AI Provider Do You want to use?");
    console.log("1. Groq (Free, Fast, Llama-3)");
    console.log("2. Gemini (Free Tier)");
    console.log("3. OpenAI (Paid)");
    console.log("4. Custom (Ollama, local, etc)");
    const choice = await askQuestion("Select (1-4): ");
    if (choice === '1') {
      provider = 'groq',
        model = 'llama-3.3-70b-versatile',
        baseUrl = 'https://api.groq.com/openai',
        console.log("\nGet your free Groq key here: https://console.groq.com/keys")
    }
    else if (choice === '2') {
      provider = 'gemini';
      model = 'gemini-2.0-flash';
      baseUrl = null;
      console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey")
    }
    else if (choice === '3') {
      provider = 'openai';
      model = 'gpt-4o';
      baseUrl = 'https://api.openai.com';
      console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys")
    }
    else if (choice === '4') {
      provider = 'custom';
      model = await askQuestion("Model name (e.g., llama3): ");
      baseUrl = await askQuestion("Base URL (e.g., http://localhost:11434): ");
    }
    const apiKey = await askQuestion("Paste your API key (leave blank for local models): ");
    rl.close()
    const config = {
      provider: provider,
      apiKey: apiKey,
      model: model,
      baseUrl: baseUrl
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    return config
  }
  else {
    rl.close();
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

module.exports = { getConfig };