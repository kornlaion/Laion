// Daily digest + budget watchdog, run inside the server (no extra service). Pushes to the owners on LINE.
const bkk = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

export async function buildDigest({ store, dailyCapThb }) {
  const s = await store.summary();
  const stuck = await store.stuckJobs(24);
  const lines = [`สรุปประจำวัน`, `ใช้วันนี้ ฿${s.spentToday.toFixed(2)} / ฿${dailyCapThb}`, `งานทั้งหมด ${s.total}`];
  for (const [k, v] of Object.entries(s.byState)) lines.push(`  ${k}: ${v}`);
  if (stuck.length) {
    lines.push('', `งานค้างเกิน 24 ชม. ${stuck.length} งาน (พิมพ์ งาน เพื่อดูรายการ):`);
    for (const j of stuck.slice(0, 5)) lines.push(`- ${j.channelId} ${j.grade} ${j.topic.slice(0, 30)} [${j.state}]`);
  }
  return lines.join('\n');
}

export function startScheduler({ store, push, owners, dailyCapThb, digestHour = Number(process.env.DIGEST_HOUR ?? 21), warnRatio = 0.8, tickMs = 60_000, now = () => new Date() }) {
  let digestOn = null, warnOn = null;
  const send = async (text) => { for (const id of owners) { try { await push(id, [{ type: 'text', text }]); } catch (e) { console.error('digest_push_error', e?.message ?? e); } } };
  async function tick() {
    const { date, hour } = bkk(now());
    try {
      const spent = await store.spentTodayThb();
      if (spent >= dailyCapThb * warnRatio && warnOn !== date) {
        warnOn = date;
        await send(`เตือนงบ: ใช้วันนี้ ฿${spent.toFixed(2)} ถึง ${Math.round((spent / dailyCapThb) * 100)}% ของเพดานรายวัน ฿${dailyCapThb}`);
      }
      if (hour >= digestHour && digestOn !== date) {
        digestOn = date;
        await send(await buildDigest({ store, dailyCapThb }));
      }
    } catch (e) { console.error('scheduler_error', e?.message ?? e); }
  }
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
