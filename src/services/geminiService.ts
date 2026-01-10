import { GoogleGenAI } from "@google/genai";

// Initialize Gemini Client
const createGeminiClient = () => {
    // The API key must be obtained exclusively from the environment variable process.env.API_KEY.
    return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

export const parseAddressInput = async (userInput: string): Promise<string> => {
    const ai = createGeminiClient();

    try {
        const model = 'gemini-3-flash-preview';
        const prompt = `
            Extract a searchable address string from the following text. 
            If the text is already an address, return it as is. 
            If it's a place name (e.g., "Colosseum Rome"), return a clean search query for a map.
            If the language is Italian, keep it Italian.
            Do not add quotes or JSON formatting. Just the plain string.
            
            Text: "${userInput}"
        `;

        const response = await ai.models.generateContent({
            model: model,
            contents: prompt,
        });

        const text = response.text;
        return text ? text.trim() : userInput;
    } catch (error) {
        console.error("Gemini parsing error:", error);
        return userInput;
    }
};