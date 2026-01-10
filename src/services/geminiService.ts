import { GoogleGenAI } from "@google/genai";

// Initialize Gemini Client
const createGeminiClient = () => {
    // Vite usa import.meta.env.VITE_API_KEY
    const apiKey = import.meta.env.VITE_API_KEY; 
    
    if (!apiKey) {
        console.warn("API_KEY not found in environment variables");
        return null;
    }
    return new GoogleGenAI({ apiKey: apiKey });
};

export const parseAddressInput = async (userInput: string): Promise<string> => {
    const ai = createGeminiClient();
    if (!ai) return userInput;

    try {
        const model = 'gemini-2.0-flash'; // Usa un modello stabile
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