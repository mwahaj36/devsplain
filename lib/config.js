const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configPath = path.join(os.homedir(), '.devsplainrc');

/**
 * Retrieves the configuration for the application.
 * If environment variables are set, it returns a configuration object based on those variables.
 * Otherwise, it prompts the user to select a provider and enter the required details.
 * @returns {Promise<Object>} A promise that resolves to a configuration object.
*/
/** Retrieves the configuration for the application. If environment variables are set, it returns a configuration object based on those variables. Otherwise, it prompts the user to select a provider and enter the required details. @returns {Promise<Object>} A promise that resolves to a configuration object. */
/** Retrieves the configuration for the application. If environment variables are set, it returns a configuration object based on those variables. Otherwise, it prompts the user to select a provider and enter the required details. @param {boolean} [forceWizard=false] - Force the wizard setup even if environment variables are set. @returns {Promise<Object>} A promise that resolves to a configuration object. */
/** Retrieves the configuration for the application. If environment variables are set, it returns a configuration object based on those variables. Otherwise, it prompts the user to select a provider and enter the required details. @param {boolean} [forceWizard=false] - Force the wizard setup even if environment variables are set. @returns {Promise<Object>} A promise that resolves to a configuration object. */
/** Retrieves the configuration for the application. If environment variables are set, it returns a configuration object based on those variables. Otherwise, it prompts the user to select a provider and enter the required details. @param {boolean} [forceWizard=false] - Force the wizard setup even if environment variables are set. @returns {Promise<Object>} A promise that resolves to a configuration object. */
async function getConfig(forceWizard = false) {
  // Check if environment variables are set for API key and provider
  // Check if environment variables are set for API key and provider
  // Check if environment variables are set for API key and provider
  // Check if environment variables are set for API key and provider
  // Check if environment variables are set for API key and provider
  if (process.env.DEVSPLAIN_API_KEY || process.env.DEVSPLAIN_PROVIDER) {
    const provider = process.env.DEVSPLAIN_PROVIDER || 'gemini';
    const model = process.env.DEVSPLAIN_MODEL || (provider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile');
    const baseUrl = process.env.DEVSPLAIN_BASE_URL || (provider === 'gemini' ? null : 'https://api.groq.com/openai');
    
    return {
      provider,
      apiKey: process.env.DEVSPLAIN_API_KEY || '',
      model,
      baseUrl
    };
  }
// If environment variables are not set, check if a configuration file exists

  // If environment variables are not set, check if a configuration file exists
  // If environment variables are not set, check if a configuration file exists
  // Check if a configuration file exists, or if the wizard setup is forced
  // If environment variables are not set, check if a configuration file exists, or if the wizard setup is forced
  if (!fs.existsSync(configPath) || forceWizard) {
    // Create a readline interface to prompt the user for input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

    let config = null;
    let confirmed = false;

    // Wizard setup loop to ensure user confirms the configuration
    // Wizard setup loop to ensure user confirms the configuration
    // Wizard setup loop to ensure user confirms the configuration
    while (!confirmed) {
      let baseUrl = "";
      let model = "";
      let provider = "";

      // Display available AI provider options to the user
      // Display available AI provider options to the user
      // Display available AI provider options to the user
      console.log("\nWhich AI Provider Do You want to use?");
      console.log("1. Groq (Free, Fast, Llama-3)");
      console.log("2. Gemini (Free Tier)");
      console.log("3. OpenAI (Paid)");
      console.log("4. Custom (Ollama, local, etc)");

      // Get the user's provider choice
      const choice = await askQuestion("Select (1-4): ");

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
        model = await askQuestion("Model name (e.g., llama3): ");
        baseUrl = await askQuestion("Base URL (e.g., http://localhost:11434): ");
      } else {
        console.log("Invalid choice. Please select 1, 2, 3, or 4.");
        continue;
      }

      // Get the API key from the user
      // Get the API key from the user
      // Get the API key from the user
      const apiKey = await askQuestion("Paste your API key (leave blank for local models): ");

      // Display the configuration summary to the user
      // Display the configuration summary to the user
      // Display the configuration summary to the user
      console.log("\n--- Configuration Summary ---");
      console.log(`Provider: ${provider}`);
      console.log(`Model:    ${model}`);
      console.log(`Base URL: ${baseUrl || 'N/A'}`);
      console.log(`API Key:  ${apiKey ? apiKey.substring(0, 4) + '*'.repeat(Math.max(0, apiKey.length - 4)) : 'None'}`);
      console.log("-----------------------------\n");

      // Confirm the configuration with the user
      // Confirm the configuration with the user
      // Confirm the configuration with the user
      const confirm = await askQuestion("Does this look correct? (y/n, default: y): ");
      if (confirm.toLowerCase() === 'y' || confirm.trim() === '') {
        config = {
          provider,
          apiKey,
          model,
          baseUrl
        };
        confirmed = true;
      } else {
        console.log("Let's restart the configuration setup.");
      }
    }

    rl.close();

    // Write the configuration object to a file
    // Write the configuration object to a file
    // Write the configuration object to a file
    // Write the configuration object to a file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Set the file permissions to ensure the API key is not readable by others (non-Windows platforms only)
    // Set the file permissions to ensure the API key is not readable by others (non-Windows platforms only)
    try {
      // Set the file permissions to ensure the API key is not readable by others (non-Windows platforms only)
      // Set the file permissions to ensure the API key is not readable by others (non-Windows platforms only)
      // Set the file permissions to ensure the API key is not readable by others (non-Windows platforms only)
      if (process.platform !== 'win32') {
        fs.chmodSync(configPath, 0o600);
      }
    } catch (chmodErr) {
    }

    // Return the configuration object
    // Return the configuration object
    // Return the configuration object
    return config;
  // Return the configuration object
  } else {
    // If a configuration file exists, read and parse its contents
    // If a configuration file exists, read and parse its contents
    // If a configuration file exists, read and parse its contents
    // If a configuration file exists, read and parse its contents
    // Read and parse the configuration file contents
    const rawData = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(rawData);
  }
}

// Export the getConfig function as a module
// Export the getConfig function as a module
// Export the getConfig function as a module
// Export the getConfig function as a module
module.exports = { getConfig };