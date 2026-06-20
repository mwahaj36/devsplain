async function getComments(code,language,config){
    const prompt=
    `
    Add comments to this ${language} code. add JSDoc/docstrings block above functions and brief inline comments for complex logic. Return ONLY the commented code. NO MARKDOWN. NO EXPLANATION. NO PERSONAL MESSAGE.
    ${code}
    `

    if(config.provider==='gemini'){
        const url=`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
        const response = await fetch(url,
            {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({
                    "contents":[{"parts":[{"text":prompt}]}]
                })
            }
        );
        const data=await response.json();
        console.log("DEBUG API RESPONSE:", data); 
        if (data.error) {
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        let text = data.candidates[0].content.parts[0].text;
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        return text;
    }
    else{
        const url=`${config.baseUrl}/v1/chat/completions`;
        const response=await fetch(url,{
            method:'POST',
            headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.apiKey}`},
            body:JSON.stringify({ "model": config.model, "messages": [{ "role": "user", "content": prompt }]
            })

        })
        const data = await response.json();
        console.log("DEBUG API RESPONSE:", data); 
         if (data.error) {
            console.error("\n API Error:", data.error.message);
            process.exit(1);
        }
        let text = data.choices[0].message.content;
        text = text.replace(/^```[\w]*\n/m, '').replace(/```$/m, '').trim();
        return text;


    }

}

module.exports={getComments};