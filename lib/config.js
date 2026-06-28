const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

// Asks for secret input from the user [ds]
function askSecret(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    process.stdout.write(query);
    process.stdin.setRawMode(true);
    let key = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(key);
      } else if (char === '\u0003') { // Ctrl+C
        process.exit();
      } else {
        key += char;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

// Migrates old config to the new format [ds]
function migrateConfig(oldConfig) {
  if (oldConfig.provider && !oldConfig.providers) {
    return {
      activeProvider: oldConfig.provider,
      providers: {
        [oldConfig.provider]: {
          apiKey: oldConfig.apiKey || '',
          model: oldConfig.model || '',
          baseUrl: oldConfig.baseUrl || null,
          autoPrune: oldConfig.autoPrune || false
        }
      }
    };
  }
  return oldConfig;
}

// Gets the config, either from environment variables, the config file, or by prompting the user [ds]
async function getConfig(forceWizard = false) {
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : (provider === 'claude' ? 'claude-3-5-sonnet-20240620' : 'llama-3.3-70b-versatile'));
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : (provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.groq.com/openai'));
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }

  let fileConfig = null;
  if (fs.existsSync(configPath)) {
    try {
      const rawData = fs.readFileSync(configPath, 'utf8');
      fileConfig = migrateConfig(JSON.parse(rawData));
    } catch (e) {
      // Ignored, file might be corrupted
    }
  }

  if (!fileConfig || forceWizard) {
    let rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    let askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = fileConfig || { activeProvider: '', providers: {} };
    let confirmed = false;

    while (!confirmed) {
      const savedProviders = Object.keys(config.providers);
      let providerToConfig = null;
      let wantToUpdate = true;
      let isNewProvider = false;

      if (savedProviders.length > 0) {
        console.log("\nSaved Providers:");
        savedProviders.forEach((p, i) => {
          const isActive = config.activeProvider === p ? ' (active)' : '';
          console.log(`${i + 1}. ${p}${isActive}`);
        });
        console.log(`\n${savedProviders.length + 1}. Add/Configure a different provider`);
        
        const c = await askQuestion(`Select (1-${savedProviders.length + 1}): `);
        const idx = parseInt(c) - 1;

        if (idx >= 0 && idx < savedProviders.length) {
          providerToConfig = savedProviders[idx];
          const update = await askQuestion(`Do you want to update the API key or model for ${providerToConfig}? (y/N): `);
          if (update.trim().toLowerCase() !== 'y' && update.trim().toLowerCase() !== 'yes') {
            wantToUpdate = false;
          }
        } else if (idx === savedProviders.length) {
          isNewProvider = true;
        } else {
          console.log("Invalid choice.");
          continue;
        }
      } else {
        isNewProvider = true;
      }

      let baseUrl = "";
      let model = "";
      let provider = "";
      let apiKey = '';
      let autoPrune = false;

      if (wantToUpdate) {
        if (isNewProvider || !providerToConfig) {
          console.log("\nWhich AI Provider Do You want to use?");
          console.log("1. Groq (Free, Fast, Llama-3)");
          console.log("2. Gemini (Free Tier)");
          console.log("3. OpenAI (Paid)");
          console.log("4. Custom (Ollama, local, etc)");
          console.log("5. Claude (Anthropic)");

          const choice = await askQuestion("Select (1-5): ");

          if (choice === '1') {
            provider = 'groq';
            baseUrl = 'https://api.groq.com/openai';
            console.log("\nGet your free Groq key here: https://console.groq.com/keys");
            const customModel = await askQuestion("Model name (press Enter for default 'llama-3.3-70b-versatile'): ");
            model = customModel.trim() || 'llama-3.3-70b-versatile';
          } else if (choice === '2') {
            provider = 'gemini';
            baseUrl = null;
            console.log("\nGet your free Gemini key here: https://aistudio.google.com/apikey");
            const customModel = await askQuestion("Model name (press Enter for default 'gemini-2.0-flash'): ");
            model = customModel.trim() || 'gemini-2.0-flash';
          } else if (choice === '3') {
            provider = 'openai';
            baseUrl = 'https://api.openai.com';
            console.log("\nGet your OpenAI key here: https://platform.openai.com/api-keys");
            const customModel = await askQuestion("Model name (press Enter for default 'gpt-4o'): ");
            model = customModel.trim() || 'gpt-4o';
          } else if (choice === '4') {
            provider = 'custom';
            while (true) {
              model = (await askQuestion("Model name (e.g., llama3): ")).trim();
              if (model) break;
              console.log("Model name cannot be empty.");
            }
            while (true) {
              baseUrl = (await askQuestion("Base URL (e.g., http://localhost:11434): ")).trim();
              if (baseUrl) break;
              console.log("Base URL cannot be empty.");
            }
          } else if (choice === '5') {
            provider = 'claude';
            baseUrl = 'https://api.anthropic.com';
            console.log("\nGet your Anthropic key here: https://console.anthropic.com/settings/keys");
            const customModel = await askQuestion("Model name (press Enter for default 'claude-3-5-sonnet-20240620'): ");
            model = customModel.trim() || 'claude-3-5-sonnet-20240620';
          } else {
            console.log("Invalid choice. Please select 1, 2, 3, 4, or 5.");
            continue;
          }
        } else {
          provider = providerToConfig;
          const old = config.providers[provider];
          baseUrl = old.baseUrl;
          
          let defaultModel = old.model;
          const customModel = await askQuestion(`Model name (press Enter for default '${defaultModel}'): `);
          model = customModel.trim() || defaultModel;

          if (provider === 'custom') {
            const customBase = await askQuestion(`Base URL (press Enter for default '${baseUrl}'): `);
            baseUrl = customBase.trim() || baseUrl;
          }
        }

        while (true) {
          const promptMsg = provider === 'custom' 
            ? "Paste your API key (leave blank for local models): " 
            : "Paste your API key: ";

          if (process.stdin.isTTY) {
            rl.close();
            apiKey = await askSecret(promptMsg);

            rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout
            });
            askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));
          } else {
            apiKey = await askQuestion(promptMsg);
          }

          apiKey = apiKey.trim();
          if (provider === 'custom' || apiKey) {
            break;
          }
          console.log(`API key is required for provider '${provider}'.`);
        }

        while (true) {
          const pruneAns = (await askQuestion("Do you want devsplain to aggressively prune (overwrite) existing human/AI comments? (y/n, default: n): ")).trim().toLowerCase();
          if (pruneAns === '' || pruneAns === 'n' || pruneAns === 'no') {
            autoPrune = false;
            break;
          } else if (pruneAns === 'y' || pruneAns === 'yes') {
            autoPrune = true;
            break;
          }
          console.log("Invalid choice. Please enter 'y' or 'n'.");
        }

        console.log("\n--- Configuration Summary ---");
        console.log(`Provider:     ${provider}`);
        console.log(`Model:        ${model}`);
        console.log(`Base URL:     ${baseUrl || 'N/A'}`);
        console.log(`API Key:      ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
        console.log(`Auto-Prune:   ${autoPrune ? 'Yes' : 'No'}`);
        console.log("-----------------------------\n");

        while (true) {
          const confirm = (await askQuestion("Does this look correct? (y/n, default: y): ")).trim().toLowerCase();
          if (confirm === '' || confirm === 'y' || confirm === 'yes') {
            config.activeProvider = provider;
            config.providers[provider] = {
              apiKey,
              model,
              baseUrl,
              autoPrune
            };
            confirmed = true;
            break;
          } else if (confirm === 'n' || confirm === 'no') {
            break; // Start over loop
          }
          console.log("Invalid choice. Please enter 'y' or 'n'.");
        }
      } else {
        // User just selected an existing provider and didn't want to update it
        config.activeProvider = providerToConfig;
        console.log(`\nSwitched active provider to ${config.activeProvider}.`);
        confirmed = true;
      }
    }

    rl.close();

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    try {
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {}

    return {
      provider: config.activeProvider,
      ...config.providers[config.activeProvider]
    };
  } else {
    return {
      provider: fileConfig.activeProvider,
      ...fileConfig.providers[fileConfig.activeProvider]
    };
  }
}

module.exports = { getConfig };
