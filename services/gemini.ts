import { GoogleGenAI, Type } from "@google/genai";
import { AiAnalysisResult } from "../types";

// Initialize Gemini Client
// IMPORTANT: process.env.API_KEY is injected by the environment.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeFrame = async (base64Image: string): Promise<AiAnalysisResult> => {
  try {
    // We strip the data:image/png;base64, prefix if it exists because the API expects just the base64 data
    const base64Data = base64Image.split(',')[1] || base64Image;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: base64Data,
            },
          },
          {
            text: `Analyze this video frame for video stabilization purposes. 
            Identify the primary subject that would be the best candidate to track (lock-on).
            
            Return the result in JSON format with these fields:
            - subject: A short name of the main subject (e.g., "Red Car", "Runner").
            - recommendation: Advice on where to place the tracker marker on this subject for best stability (high contrast area).
            - confidence: High/Medium/Low based on visual clarity.
            `
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            subject: { type: Type.STRING },
            recommendation: { type: Type.STRING },
            confidence: { type: Type.STRING }
          },
          required: ["subject", "recommendation", "confidence"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");
    
    return JSON.parse(text) as AiAnalysisResult;

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      subject: "Unknown",
      recommendation: "Could not analyze frame. Please try again.",
      confidence: "Low"
    };
  }
};
