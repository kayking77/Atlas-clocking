import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { supabase, readError } from '../lib/supabase';
import { getFix, distanceM, formatCoords } from '../lib/location';
import { fmtElapsed, fmtTime, fmtDay } from '../lib/format';
import { useTheme, mono } from '../theme';
import { Button, Card, Field, Label, Notice, Pill } from '../ui';

const FIX_MAX_AGE_MS = 60 * 1000;

export default function ClockScreen({ profile, onChanged }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(null);          // open clock_entries_detail row, or null
  const [openHouse, setOpenHouse] = useState(null); // {lat,lng,radius_m} for the open shift's house
  const [loading, setLoading] = useState(true);
  const [fix, setFix] = useState(null);
  const [match, setMatch] = useState(null);        // locate_house() result (when off the clock)
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(null);
  const [note, setNote] = useState('');
  const [needNote, setNeedNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);    // {tone, text}
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, []);

  const loadOpen = useCallback(async () => {
    const { data, error } = await supabase
      .from('clock_entries_detail')
      .select('*')
      .eq('staff_id', profile.id)
      .is('clock_out', null)
      .maybeSingle();
    if (!mounted.current) return null;
    if (error) {
      setMessage({ tone: 'bad', text: readError(error).message });
      return null;
    }
    setOpen(data || null);
    if (data) {
      const { data: h } = await supabase.from('houses').select('lat,lng,radius_m').eq('id', data.house_id).single();
      if (mounted.current) setOpenHouse(h || null);
    } else {
      setOpenHouse(null);
    }
    return data || null;
  }, [profile.id]);

  const locate = useCallback(async (openRow) => {
    setLocating(true);
    setLocError(null);
    try {
      const f = await getFix();
      if (!mounted.current) return null;
      setFix(f);
      if (!openRow) {
        const { data, error } = await supabase.rpc('locate_house', { p_lat: f.lat, p_lng: f.lng });
        if (error) throw readError(error);
        setMatch(Array.isArray(data) ? data[0] || null : data);
      }
      return f;
    } catch (e) {
      if (mounted.current) setLocError(e && e.message ? e : { message: String(e) });
      return null;
    } finally {
      if (mounted.current) setLocating(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const row = await loadOpen();
    setLoading(false);
    await locate(row);
  }, [loadOpen, locate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Distance from the open shift's house, computed on the phone for display only.
  const openDist = open && openHouse && fix ? Math.round(distanceM(fix.lat, fix.lng, openHouse.lat, openHouse.lng)) : null;
  const openInside = openDist != null && openHouse ? openDist <= openHouse.radius_m : null;
  const outsideNow = open ? openInside === false : match ? !match.inside : false;
  const showNote = needNote || outsideNow;

  async function freshFix() {
    if (fix && Date.now() - fix.at < FIX_MAX_AGE_MS) return fix;
    return locate(open);
  }

  async function doClockIn() {
    setMessage(null);
    const f = await freshFix();
    if (!f) return;
    if (showNote && !note.trim()) {
      setNeedNote(true);
      setMessage({ tone: 'warn', text: 'You’re outside the house geofence. Add a note saying where you are and why.' });
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('clock_in', {
      p_lat: f.lat,
      p_lng: f.lng,
      p_accuracy: f.accuracy,
      p_mocked: f.mocked,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      const e = readError(error);
      if (e.code === 'OUTSIDE_GEOFENCE') setNeedNote(true);
      setMessage({ tone: e.code === 'OUTSIDE_GEOFENCE' ? 'warn' : 'bad', text: e.message });
      return;
    }
    setNote('');
    setNeedNote(false);
    await loadOpen();
    setMessage({ tone: 'on', text: 'You’re clocked in.' });
    onChanged && onChanged();
  }

  function confirmClockOut() {
    Alert.alert('Clock out now?', open ? `Ending your shift at ${open.house_name}.` : '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clock out', style: 'destructive', onPress: doClockOut },
    ]);
  }

  async function doClockOut() {
    setMessage(null);
    const f = await freshFix();
    if (!f) return;
    const outside = openHouse ? distanceM(f.lat, f.lng, openHouse.lat, openHouse.lng) > openHouse.radius_m : false;
    if (outside && !note.trim()) {
      setNeedNote(true);
      setMessage({ tone: 'warn', text: 'You’re outside the house geofence. Add a note saying where you are and why.' });
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('clock_out', {
      p_lat: f.lat,
      p_lng: f.lng,
      p_accuracy: f.accuracy,
      p_mocked: f.mocked,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      const e = readError(error);
      if (e.code === 'OUTSIDE_GEOFENCE') setNeedNote(true);
      setMessage({ tone: e.code === 'OUTSIDE_GEOFENCE' ? 'warn' : 'bad', text: e.message });
      return;
    }
    const hours = data && data.clock_out ? (Date.parse(data.clock_out) - Date.parse(data.clock_in)) / 3.6e6 : null;
    setNote('');
    setNeedNote(false);
    setOpen(null);
    setOpenHouse(null);
    setMessage({ tone: 'on', text: hours != null ? `Clocked out. ${hours.toFixed(2)} hours recorded.` : 'Clocked out.' });
    onChanged && onChanged();
    locate(null);
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={c.muted} />}
      keyboardShouldPersistTaps="handled"
    >
      {/* Status */}
      <Card style={{ gap: 14, borderColor: open ? c.on : c.line }}>
        {open ? (
          <>
            <Pill tone="on">● On the clock</Pill>
            <Text style={{ color: c.ink, fontFamily: mono, fontSize: 46, fontVariant: ['tabular-nums'], letterSpacing: -1 }}>
              {fmtElapsed(now - Date.parse(open.clock_in))}
            </Text>
            <View style={{ gap: 2 }}>
              <Text style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>{open.house_name}</Text>
              <Text style={{ color: c.muted, fontSize: 14 }}>{open.org_name}</Text>
              <Text style={{ color: c.muted, fontSize: 14 }}>{open.house_address}</Text>
            </View>
            <Text style={{ color: c.muted, fontSize: 14 }}>
              Clocked in {fmtDay(open.work_date)} at {fmtTime(open.clock_in_local)}
              {open.flagged ? ' · flagged for review' : ''}
            </Text>
          </>
        ) : (
          <>
            <Pill>Off the clock</Pill>
            <Text style={{ color: c.ink, fontSize: 22, fontWeight: '700' }}>
              {match ? match.house_name : locating ? 'Finding your house…' : 'Location needed'}
            </Text>
            {match ? (
              <View style={{ gap: 2 }}>
                <Text style={{ color: c.muted, fontSize: 14 }}>{match.org_name}</Text>
                <Text style={{ color: c.muted, fontSize: 14 }}>{match.address}</Text>
              </View>
            ) : null}
          </>
        )}
      </Card>

      {/* Location readout */}
      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Label>Your location</Label>
          {fix ? (
            open ? (
              openInside == null ? null : <Pill tone={openInside ? 'on' : 'warn'}>{openInside ? 'Inside geofence' : 'Outside geofence'}</Pill>
            ) : match ? (
              <Pill tone={match.inside ? 'on' : 'warn'}>{match.inside ? 'Inside geofence' : 'Outside geofence'}</Pill>
            ) : null
          ) : null}
        </View>
        {locError ? (
          <Notice tone="bad">{locError.message}</Notice>
        ) : fix ? (
          <>
            <Text style={{ color: c.ink, fontFamily: mono, fontSize: 14 }}>{formatCoords(fix.lat, fix.lng)}</Text>
            <Text style={{ color: c.muted, fontFamily: mono, fontSize: 13 }}>
              ±{fix.accuracy ?? '?'} m accuracy
              {open && openDist != null ? ` · ${openDist} m from ${open.house_name} (limit ${openHouse.radius_m} m)` : ''}
              {!open && match ? ` · ${match.distance_m} m from house (limit ${match.radius_m} m)` : ''}
            </Text>
            {fix.mocked ? <Notice tone="bad">Your phone reports a simulated location. This punch will be flagged.</Notice> : null}
          </>
        ) : (
          <Text style={{ color: c.muted, fontSize: 14 }}>{locating ? 'Getting a GPS fix…' : 'No location yet.'}</Text>
        )}
        <Button title={locating ? 'Locating…' : 'Refresh location'} kind="quiet" onPress={() => locate(open)} busy={locating} />
      </Card>

      {showNote ? (
        <Field
          label="Note for your supervisor (required outside the geofence)"
          value={note}
          onChangeText={setNote}
          placeholder="e.g. Took a resident to a medical appointment"
          multiline
          maxLength={500}
        />
      ) : null}

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {open ? (
        <Button title="Clock out" kind="stop" big busy={busy} disabled={locating} onPress={confirmClockOut} />
      ) : (
        <Button title="Clock in" kind="go" big busy={busy} disabled={locating || !match} onPress={doClockIn} />
      )}

      <Text style={{ color: c.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' }}>
        Location is recorded only when you clock in or out. Times are set by the Atlas server, not your phone.
      </Text>
    </ScrollView>
  );
}
