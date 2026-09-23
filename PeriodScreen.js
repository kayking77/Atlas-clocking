import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { supabase, readError } from '../lib/supabase';
import { fmtDay, fmtHours, fmtShortDate, fmtTime, isNextDay } from '../lib/format';
import { useTheme, mono } from '../theme';
import { Button, Card, Label, Notice, Pill } from '../ui';

const ATTESTATION = 'I confirm the hours in this timesheet are accurate and complete for this pay period.';

export default function PeriodScreen({ profile, refreshKey }) {
  const { c } = useTheme();
  const [offset, setOffset] = useState(0);
  const [period, setPeriod] = useState(null);
  const [today, setToday] = useState(null);
  const [entries, setEntries] = useState([]);
  const [submission, setSubmission] = useState(null);
  const [closed, setClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [{ data: pp, error: e1 }, { data: t, error: e2 }] = await Promise.all([
        supabase.rpc('pay_period', { p_offset: offset }),
        supabase.rpc('local_today'),
      ]);
      if (e1 || e2) throw e1 || e2;
      const p = Array.isArray(pp) ? pp[0] : pp;
      setPeriod(p);
      setToday(t);
      const [{ data: rows, error: e3 }, { data: sub }, { data: cl }] = await Promise.all([
        supabase
          .from('clock_entries_detail')
          .select('id,clock_in,clock_out,clock_in_local,clock_out_local,work_date,hours,house_name,org_name,flagged,in_note,out_note,admin_note,source')
          .eq('staff_id', profile.id)
          .eq('period_start', p.period_start)
          .order('clock_in', { ascending: true }),
        supabase.from('timesheet_submissions').select('*').eq('staff_id', profile.id).eq('period_start', p.period_start).maybeSingle(),
        supabase.from('period_closures').select('period_start').eq('period_start', p.period_start).maybeSingle(),
      ]);
      if (e3) throw e3;
      setEntries(rows || []);
      setSubmission(sub || null);
      setClosed(Boolean(cl));
      setAgree(false);
    } catch (e) {
      setMessage({ tone: 'bad', text: readError(e).message });
    } finally {
      setLoading(false);
    }
  }, [offset, profile.id]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const totals = useMemo(() => {
    const byHouse = new Map();
    let total = 0;
    for (const e of entries) {
      if (e.hours == null) continue;
      const k = `${e.org_name} · ${e.house_name}`;
      byHouse.set(k, (byHouse.get(k) || 0) + Number(e.hours));
      total += Number(e.hours);
    }
    return { byHouse: [...byHouse.entries()].sort((a, b) => a[0].localeCompare(b[0])), total };
  }, [entries]);

  const hasOpen = entries.some((e) => !e.clock_out);
  const periodEnded = period && today ? today >= period.period_end : false;
  const canSubmit = periodEnded && !closed && !hasOpen && agree;

  async function submit() {
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.rpc('submit_timesheet', { p_period_start: period.period_start, p_attestation: ATTESTATION });
    setBusy(false);
    if (error) {
      setMessage({ tone: 'bad', text: readError(error).message });
      return;
    }
    setSubmission(data);
    setMessage({ tone: 'on', text: `Timesheet submitted: ${fmtHours(data.total_hours)} hours.` });
  }

  // group entries by work date
  const days = useMemo(() => {
    const m = new Map();
    for (const e of entries) {
      if (!m.has(e.work_date)) m.set(e.work_date, []);
      m.get(e.work_date).push(e);
    }
    return [...m.entries()];
  }, [entries]);

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={c.muted} />}
    >
      {/* Period header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Pressable onPress={() => setOffset(offset - 1)} accessibilityLabel="Previous pay period" hitSlop={12} style={{ padding: 8 }}>
          <Text style={{ color: c.accent, fontSize: 22, fontWeight: '700' }}>‹</Text>
        </Pressable>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Label>{offset === 0 ? 'Current pay period' : offset === -1 ? 'Last pay period' : 'Pay period'}</Label>
          <Text style={{ color: c.ink, fontSize: 18, fontWeight: '700', marginTop: 4 }}>
            {period ? `${fmtShortDate(period.period_start)} – ${fmtShortDate(period.period_end)}` : '—'}
          </Text>
        </View>
        <Pressable
          onPress={() => offset < 0 && setOffset(offset + 1)}
          accessibilityLabel="Next pay period"
          hitSlop={12}
          style={{ padding: 8, opacity: offset < 0 ? 1 : 0.25 }}
        >
          <Text style={{ color: c.accent, fontSize: 22, fontWeight: '700' }}>›</Text>
        </Pressable>
      </View>

      {/* Totals */}
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Label>Total hours</Label>
          <Text style={{ color: c.ink, fontFamily: mono, fontSize: 34, fontVariant: ['tabular-nums'] }}>{fmtHours(totals.total)}</Text>
        </View>
        {totals.byHouse.length ? (
          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
            {totals.byHouse.map(([k, h]) => (
              <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <Text style={{ color: c.muted, fontSize: 14, flex: 1 }}>{k}</Text>
                <Text style={{ color: c.ink, fontFamily: mono, fontSize: 14, fontVariant: ['tabular-nums'] }}>{fmtHours(h)}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={{ color: c.muted, fontSize: 14 }}>No completed shifts in this period yet.</Text>
        )}
      </Card>

      {/* Shifts */}
      {days.map(([date, rows]) => (
        <View key={date} style={{ gap: 8 }}>
          <Label>{fmtDay(date)}</Label>
          {rows.map((e) => (
            <Card key={e.id} style={{ gap: 6, paddingVertical: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                <Text style={{ color: c.ink, fontSize: 16, fontWeight: '700', flex: 1 }}>{e.house_name}</Text>
                <Text style={{ color: c.ink, fontFamily: mono, fontSize: 16, fontVariant: ['tabular-nums'] }}>
                  {e.clock_out ? fmtHours(e.hours) : 'open'}
                </Text>
              </View>
              <Text style={{ color: c.muted, fontFamily: mono, fontSize: 13 }}>
                {fmtTime(e.clock_in_local)} → {e.clock_out ? fmtTime(e.clock_out_local) : '…'}
                {isNextDay(e.clock_in_local, e.clock_out_local) ? ' (+1 day)' : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {!e.clock_out ? <Pill tone="on">On the clock</Pill> : null}
                {e.flagged ? <Pill tone="warn">Flagged for review</Pill> : null}
                {e.source === 'admin' ? <Pill tone="accent">Entered by supervisor</Pill> : null}
              </View>
              {e.admin_note ? <Text style={{ color: c.muted, fontSize: 13 }}>Supervisor: {e.admin_note}</Text> : null}
            </Card>
          ))}
        </View>
      ))}

      {/* Submit */}
      <Card style={{ gap: 12 }}>
        <Label>Timesheet</Label>
        {submission ? (
          <Notice tone="on">
            Submitted {fmtShortDate(String(submission.submitted_at).slice(0, 10))} · {fmtHours(submission.total_hours)} hours across {submission.entry_count} shifts.
            {!closed ? ' You can resubmit if a shift changes.' : ''}
          </Notice>
        ) : null}
        {closed ? (
          <Text style={{ color: c.muted, fontSize: 14 }}>This pay period is closed. Contact your supervisor about any corrections.</Text>
        ) : !periodEnded ? (
          <Text style={{ color: c.muted, fontSize: 14 }}>
            You can submit this timesheet on the last day of the period, {period ? fmtShortDate(period.period_end) : ''}.
          </Text>
        ) : hasOpen ? (
          <Notice tone="warn">Clock out of your open shift before submitting.</Notice>
        ) : (
          <>
            <Pressable
              onPress={() => setAgree(!agree)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agree }}
              style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}
            >
              <View
                style={{
                  width: 24, height: 24, borderRadius: 6, borderWidth: 2,
                  borderColor: agree ? c.accent : c.muted, backgroundColor: agree ? c.accent : 'transparent',
                  alignItems: 'center', justifyContent: 'center', marginTop: 1,
                }}
              >
                {agree ? <Text style={{ color: c.accentInk, fontWeight: '900' }}>✓</Text> : null}
              </View>
              <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21, flex: 1 }}>{ATTESTATION}</Text>
            </Pressable>
            <Button title={submission ? 'Resubmit timesheet' : 'Submit timesheet'} onPress={submit} busy={busy} disabled={!canSubmit} />
          </>
        )}
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </Card>
    </ScrollView>
  );
}
