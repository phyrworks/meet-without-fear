import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load env vars
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not found in environment');
  process.exit(1);
}

const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const TEXT = "Hello! I'm here to support you on your journey.";
const OUTPUT_DIR = path.join(__dirname, '../../temp_voices');

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function generateVoice(voice: string) {
  console.log(`Generating preview for ${voice}...`);
  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: TEXT,
        voice: voice,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error: ${error}`);
    }

    const buffer = await response.arrayBuffer();
    const filePath = path.join(OUTPUT_DIR, `${voice}.mp3`);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    console.log(`Saved ${filePath}`);
  } catch (error) {
    console.error(`Failed to generate ${voice}:`, error);
  }
}

async function main() {
  for (const voice of VOICES) {
    await generateVoice(voice);
  }
  console.log('Done!');
}

main();
