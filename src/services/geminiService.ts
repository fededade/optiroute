import { GoogleGenAI } from "@google/genai";

// Resolve the API key from Vite env (VITE_GEMINI_API_KEY) or, if defined,
// from process.env.API_KEY. Never throw: without a key we simply skip the
// AI cleanup step and use the raw user input.
const getApiKey = (): string | undefined => {
    const viteKey = (import.meta as any).env?.VITE_GEMINI_API_KEY as string | undefined;
    if (viteKey) return viteKey;
    if (typeof process !== 'undefined' && process.env?.API_KEY) {
        return process.env.API_KEY;
    }
    return undefined;
};

export const parseAddressInput = async (userInput: string): Promise<string> => {
    const apiKey = getApiKey();
    if (!apiKey) return userInput;

    try {
        const ai = new GoogleGenAI({ apiKey });
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
