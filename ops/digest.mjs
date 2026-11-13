// Daily digest + budget watchdog, run inside the server (no extra service). Pushes to the owners on LINE.
const bkk = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
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

export function startScheduler({ store, push, owners, dailyCapThb, digestHour = Number(process.env.DIGEST_HOUR ?? 20), researchAt = process.env.RESEARCH_TIME ?? '07:30', research, warnRatio = 0.8, tickMs = 60_000, now = () => new Date() }) {
  // Marks live in the database (audit_log), so a redeploy or restart never repeats a message already sent today.
  const once = async (kind, date, fn) => {
    const key = `${kind}:${date}`;
    if (await store.wasDone(key)) return;
    await fn();
    await store.markDone(key);
  };
  const [rh, rm] = researchAt.split(':').map(Number);
  const send = async (text) => { for (const id of owners) { try { await push(id, [{ type: 'text', text }]); } catch (e) { console.error('digest_push_error', e?.message ?? e); } } };
  async function tick() {
    const { date, hour, minute } = bkk(now());
    try {
      const spent = await store.spentTodayThb();
      if (spent >= dailyCapThb * warnRatio) {
        await once('budget-warn', date, () => send(`เตือนงบ: ใช้วันนี้ ฿${spent.toFixed(2)} ถึง ${Math.round((spent / dailyCapThb) * 100)}% ของเพดานรายวัน ฿${dailyCapThb}`));
      }
      if (research && (hour > rh || (hour === rh && minute >= rm))) await once('research', date, async () => {
        const done = [], failed = [];
        for (const ch of await store.listChannels()) {
          try { const r = await research(ch, date); (r.ok ? done : failed).push(r.ok ? (r.replay ? `${ch} (มีแล้ว)` : `${ch} ${r.count}`) : `${ch}: ${r.reason}`); }
          catch (e) { failed.push(`${ch}: ${e?.message ?? e}`); }
        }
        await send(['ไอเดียหัวข้อวันนี้พร้อมแล้ว', done.join(' · ') || '-', ...(failed.length ? ['ไม่สำเร็จ:', ...failed] : []), '', 'พิมพ์ ไอเดีย <ช่อง> เช่น ไอเดีย love เพื่อดูและเลือกผลิต'].join('\n'));
      });
      if (hour >= digestHour) await once('digest', date, async () => send(await buildDigest({ store, dailyCapThb })));
    } catch (e) { console.error('scheduler_error', e?.message ?? e); }
  }
  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
