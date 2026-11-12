// ChatGPT Image adapter (OpenAI Images API). Request shape NOT yet verified against a live call.
// The model name must match the model_id you put in provider_rates. Override with OPENAI_IMAGE_MODEL.
export function createOpenAIImageAdapter({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  fetchImpl = fetch,
} = {}) {
  return {
    unit: 'image',
    // Rates are looked up per quality tier, e.g. 'gpt-image-2:low' | ':medium' | ':high'
    model: (p) => `${model}:${p.quality ?? 'medium'}`,
    units: (p) => p.n ?? 1,
    async call(p) {
      if (!apiKey) throw new Error('OPENAI_API_KEY missing');
      const res = await fetchImpl('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          prompt: p.prompt,
          size: p.size ?? '1024x1536',      // portrait for Shorts / Reels
          quality: p.quality ?? 'medium',
          n: p.n ?? 1,
          output_format: 'jpeg',            // small enough for LINE preview (<1MB)
          output_compression: 80,
        }),
      });
      if (!res.ok) throw new Error(`openai_image_${res.status}`);   // body not logged: may echo prompt
      const json = await res.json();
      const images = (json.data ?? []).filter((d) => d.b64_json).map((d) => Buffer.from(d.b64_json, 'base64'));
      if (!images.length) throw new Error('openai_image_empty');
      return { images, externalId: json.created ? String(json.created) : null };
    },
  };
}
