try {
  process.loadEnvFile('.env');
} catch {
  // .env opsional
}

export const config = {
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
  llmApiKey: process.env.LLM_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? 'deepseek-flash',
  minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.8),
  concurrency: Number(process.env.CONCURRENCY ?? 4),
  dataDir: 'data',
};
