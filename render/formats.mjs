// Clip formats: target length by content type. Default is the 20-25 s standard clip.
// Estimate: seconds = 3 (opening + closing) + characters / 12 (Thai speech) + 1.2 per scene (fades and pause), with scenes of ~40 characters.
export const MODES = {
  viral: { label: 'ไวรัล', aliases: ['ไวรัล', 'สั้นมาก'], secs: [7, 15], target: 12, note: 'คลิปไวรัล มุกตลก ภาพสวย ดึงความสนใจ' },
  standard: { label: 'มาตรฐาน', aliases: ['มาตรฐาน'], secs: [20, 25], target: 22, note: 'ความยาวเดียวที่แนะนำให้เริ่ม' },
  sell: { label: 'ขาย', aliases: ['ขาย', 'รีวิว', 'โปรโมต'], secs: [15, 30], target: 25, note: 'รีวิวสินค้า โปรโมต คลิปขายของ' },
  story: { label: 'เล่าเรื่อง', aliases: ['เล่าเรื่อง', 'ความรู้'], secs: [30, 45], target: 38, note: 'เล่าเรื่อง ให้ความรู้ เทคนิคสั้น ๆ' },
  detail: { label: 'ละเอียด', aliases: ['ละเอียด'], secs: [45, 60], target: 52, note: 'รีวิวละเอียด สาธิต เรื่องหลายขั้นตอน' },
  long: { label: 'ยาว', aliases: ['ยาว'], secs: [60, 90], target: 75, note: 'Storytelling หรือเรื่องที่ต้องอธิบายมาก' },
};
export const DEFAULT_MODE = 'standard';

export function modeByName(name) {
  const n = String(name ?? '').trim();
  return Object.entries(MODES).find(([, m]) => m.aliases.includes(n))?.[0] ?? null;
}

const PER_CHAR = 1 / 12 + 1.2 / 40;
export const charsForSeconds = (sec) => Math.max(40, Math.round((sec - 3) / PER_CHAR));
export const estimateSeconds = (chars, scenes) => 3 + chars / 12 + 1.2 * scenes;

/** Character budget for a mode: { min, target, max }. */
export function lengthFor(modeKey) {
  const m = MODES[modeKey] ?? MODES[DEFAULT_MODE];
  return { min: charsForSeconds(m.secs[0]), target: charsForSeconds(m.target), max: charsForSeconds(m.secs[1]) };
}
