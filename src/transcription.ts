import { createReadStream } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import OpenAI from 'openai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

function getOpenAIClient(): OpenAI | null {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || '';
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — voice transcription unavailable');
    return null;
  }
  return new OpenAI({ apiKey });
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 * @param audioBuffer - Raw audio bytes (OGG, MP3, MP4, WAV, etc.)
 * @param filename - Filename with extension so Whisper knows the format (e.g. "voice.ogg")
 * @returns Transcript string, or null on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  const tmpPath = join(tmpdir(), `nanoclaw-voice-${Date.now()}-${filename}`);
  try {
    await writeFile(tmpPath, audioBuffer);
    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(tmpPath),
      model: 'whisper-1',
    });
    logger.info(
      { chars: transcription.text.length },
      'Transcribed voice message',
    );
    return transcription.text;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  } finally {
    unlink(tmpPath).catch(() => {});
  }
}
