import { apiPath, workspacePath } from "./paths.mjs";
import React, { useEffect, useRef, useState } from "react";
import { audio } from "./audio.mjs";
import { routeMidiInputs } from "./midi.mjs";
import { matchPracticeNote } from "../engine/scoring.mjs";
import { PARAMS, FAMILIES, DEFAULT_PATCH } from "../engine/synth.mjs";
import { DRUM_PARAMS, DRUM_LABELS } from "../engine/drums.mjs";
import "./style.css";
import AnalysisHistory from "./AnalysisHistory.jsx";
import DemucsSeparation from "./DemucsSeparation.jsx";
import Arrangement from "./Arrangement.jsx";
import { audibleIds, clamp } from "./timeline.mjs";

const COLORS = [
  "#b3a3ff",
  "#b9ee84",
  "#ffb88a",
  "#82d8e5",
  "#e79edb",
  "#ffe18b",
  "#86a7ff",
  "#e6b89c",
];
const noteName = (p) =>
  ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][
    ((p % 12) + 12) % 12
  ] +
  (Math.floor(p / 12) - 1);
const stamp = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function startingOctave(notes) {
  if (!notes.length) return 4;
  const preferred = Math.max(
    0,
    Math.min(7, Math.floor(Math.min(...notes.map((n) => n.pitch)) / 12) - 1),
  );
  let best = preferred,
    count = -1;
  for (const octave of [preferred, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const first = 12 * (octave + 1);
    const playable = notes.filter(
      (n) => n.pitch >= first && n.pitch < first + 16,
    ).length;
    if (playable > count) {
      best = octave;
      count = playable;
    }
  }
  return best;
}
async function request(url, options) {
  const res = await fetch(apiPath(url), options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
export default function InstrumentLabEditor({
  initialProjectId = null,
  embedded = false,
  onExit,
  onStartLesson,
  renderSourceEditor,
} = {}) {
  const [projects, setProjects] = useState([]),
    [project, setProject] = useState(null),
    [selected, setSelected] = useState(null),
    [patch, setPatch] = useState(DEFAULT_PATCH),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("sound"),
    [dirty, setDirty] = useState(false),
    [edit, setEdit] = useState(null),
    [notes, setNotes] = useState([]),
    [speed, setSpeed] = useState(1),
    [loop, setLoop] = useState(false),
    [range, setRange] = useState([0, 0]),
    [held, setHeld] = useState(new Set()),
    [feedback, setFeedback] = useState("Play a note to hear this instrument"),
    [score, setScore] = useState({ hit: 0, wrong: 0 }),
    [devices, setDevices] = useState([]),
    [deviceId, setDeviceId] = useState(""),
    [octave, setOctave] = useState(4);
  const [muted, setMuted] = useState([]),
    [solo, setSolo] = useState([]);
  const [playbackScope, setPlaybackScope] = useState("detail");
  const [playbackPartId, setPlaybackPartId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [mixMode, setMixMode] = useState("reconstruction");
  const [stemModes, setStemModes] = useState({});
  const mode = stemModes[selected] || "synth";
  const setMode = (value) =>
    setStemModes((current) => ({ ...current, [selected]: value }));
  const [preparing, setPreparing] = useState(false);
  const [instrumentName, setInstrumentName] = useState("");
  const [noteSelection, setNoteSelection] = useState([]),
    [assignmentTarget, setAssignmentTarget] = useState(""),
    [splitName, setSplitName] = useState("");
  const drafts = useRef(null);
  if (drafts.current === null) {
    try {
      const saved = JSON.parse(
        localStorage.getItem("melodics-instrument-drafts") || "{}",
      );
      drafts.current =
        saved && typeof saved === "object" && !Array.isArray(saved)
          ? saved
          : {};
    } catch {
      drafts.current = {};
    }
  }
  const playbackGeneration = useRef(0),
    loopTimer = useRef(null);
  const rollViewport = useRef(null);
  const fileRef = useRef(),
    transport = useRef(null),
    matched = useRef(new Set()),
    activeKeys = useRef(new Map()),
    midiRef = useRef(null),
    latest = useRef({}),
    polling = useRef(null);
  const result = project?.result,
    parts = result?.parts || [],
    part = parts.find((p) => p.id === selected),
    partIndex = parts.findIndex((p) => p.id === selected),
    color = COLORS[Math.max(0, partIndex) % COLORS.length];
  const isDrum = part?.engine === "drum" || patch.engine === "drum";
  const pendingAnalyses =
    project?.analyses?.filter((a) =>
      ["queued", "analyzing"].includes(a.status),
    ) || [];
  const analysisSignature = project?.analyses
    ?.map((a) => `${a.id}:${a.status}:${a.revision}`)
    .join("|");
  const playablePatch =
    part?.engine === "drum"
      ? {
          ...patch,
          assetUrl: apiPath(
            `/api/projects/${part.ownerProjectId || project.id}/audio/${part.sampleFile}`,
          ),
        }
      : patch;
  const playableParts = parts.map((p) => ({
    ...p,
    assetUrl: apiPath(
      `/api/projects/${p.ownerProjectId || project.id}/audio/${p.sampleFile}`,
    ),
  }));
  const audible = audibleIds(parts, muted, solo);
  function toggleMix(kind, id) {
    const toggle = (items) =>
      items.includes(id) ? items.filter((x) => x !== id) : [...items, id];
    const nextMuted = kind === "muted" ? toggle(muted) : muted;
    const nextSolo = kind === "solo" ? toggle(solo) : solo;
    setMuted(nextMuted);
    setSolo(nextSolo);
    const ids = audibleIds(parts, nextMuted, nextSolo);
    audio.setMixAudible(ids);
    if (
      (playing || preparing) &&
      playbackScope === "detail" &&
      tab === "practice"
    ) {
      play({ offset: time, audible: ids });
    }
  }
  function seek(value, auditionOwner) {
    window.dispatchEvent(new CustomEvent("lab-audition", {detail:auditionOwner}));
    const wasPlaying = playing || preparing;
    const tr = transport.current;
    stop();
    setTime(value);
    if (wasPlaying && value < result.duration)
      play({
        offset: value,
        scope: tr?.scope || playbackScope,
        part: parts.find((p) => p.id === (tr?.partId || playbackPartId)),
        end: value >= range[1] ? result.duration : tr?.end,
        lower: value < range[0] ? 0 : tr?.lower,
      });
  }
  function expandLane(p, toggle = false) {
    if (toggle && expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    if (selected !== p.id) choose(p);
    if (expandedId !== p.id) setTab("notes");
    setExpandedId(p.id);
  }
  function playLane(p) {
    if (
      (playing || preparing) &&
      playbackScope !== "mix" &&
      playbackPartId === p.id
    )
      stop();
    else play({ scope: "stem", part: p });
  }
  latest.current = {
    project,
    part,
    patch,
    notes,
    playing,
    tab,
    speed,
    range,
    loop,
    octave,
    deviceId,
    instrumentName,
    dirty,
    parts,
    play,
  };
  const refresh = async () => {
    setProjects(await request("/api/projects"));
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const projectId =
      initialProjectId ||
      new URLSearchParams(window.location.search).get("project");
    if (projectId) open(projectId);
    return () => {
      clearTimeout(loopTimer.current);
      audio.stop();
      audio.mixBuffers.clear();
      midiRef.current?.dispose();
    };
  }, []);
  function accept(p) {
    if (p.id !== project?.id) {
      audio.mixBuffers.clear();
      setTime(0);
      setMuted([]);
      setSolo([]);
      setPlaybackScope("detail");
      setExpandedId(null);
      setStemModes({});
    }
    setProject(p);
    setEdit(null);
    setNoteSelection([]);
    setAssignmentTarget("");
    setSplitName("");
    if (p.result) {
      const initial =
        p.result.parts.find((x) => x.id === selected) || p.result.parts[0];
      if (!initial) {
        setSelected(null);
        setNotes([]);
        setDirty(false);
        return;
      }
      const draft =
        drafts.current[p.id + ":" + initial.id] ||
        drafts.current[
          (initial.ownerProjectId || p.id) +
            ":" +
            (initial.ownerPartId || initial.id)
        ];
      setSelected(initial.id);
      setPatch(draft?.patch || initial.patch);
      setNotes(draft?.notes || initial.notes);
      setInstrumentName(draft?.name ?? initial.name);
      setRange([0, p.result.duration]);
      setDirty(!!draft);
      setOctave(startingOctave(draft?.notes || initial.notes));
    } else {
      // A queued analysis has no editable instrument yet. Clear the prior form
      // together with the project switch so its draft cannot acquire the new ID.
      setSelected(null);
      setPatch(DEFAULT_PATCH);
      setNotes([]);
      setInstrumentName("");
      setDirty(false);
      setRange([0, 0]);
    }
  }
  async function open(id) {
    stop();
    setError("");
    try {
      accept(
        await request(`/api/projects/${id}/analyze-instruments`, {
          method: "POST",
        }),
      );
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (project)
      setProjects((items) =>
        items.map((item) =>
          item.id === project.id ? { ...item, status: project.status } : item,
        ),
      );
  }, [project?.id, project?.status]);
  useEffect(() => {
    if (
      !project ||
      (!["queued", "analyzing"].includes(project.status) &&
        !pendingAnalyses.length)
    )
      return;
    let disposed = false;
    const timer = setInterval(async () => {
      try {
        const p = await request("/api/projects/" + project.id);
        if (!disposed) {
          setProject(p);
          if (
            p.status === "ready" &&
            p.analyses
              ?.map((a) => `${a.id}:${a.status}:${a.revision}`)
              .join("|") !== analysisSignature
          ) {
            accept(p);
            refresh();
          }
        }
      } catch (e) {
        if (!disposed) setError(e.message);
      }
    }, 1200);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [project?.id, project?.status, analysisSignature]);
  useEffect(() => {
    if (part) {
      audio.patch(playablePatch).catch((e) => setError(e.message));
    }
  }, [selected, patch]);
  useEffect(() => {
    if (project?.result?.parts.some(p => p.id === selected) && dirty) {
      drafts.current[project.id + ":" + selected] = {
        patch,
        notes,
        name: instrumentName,
      };
      try {
        localStorage.setItem(
          "melodics-instrument-drafts",
          JSON.stringify(drafts.current),
        );
      } catch {}
    }
  }, [project?.id, selected, patch, notes, instrumentName, dirty]);
  async function upload(file) {
    if (!file) return;
    stop();
    setBusy(true);
    setError("");
    try {
      const p = await request(
        "/api/projects?filename=" + encodeURIComponent(file.name),
        { method: "POST", body: file },
      );
      accept(p);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function demo() {
    stop();
    setBusy(true);
    setError("");
    try {
      setProject(await request("/api/demo", { method: "POST" }));
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function choose(p) {
    if (playbackScope !== "mix") stop();
    setSelected(p.id);
    const draft =
      drafts.current[project.id + ":" + p.id] ||
      drafts.current[
        (p.ownerProjectId || project.id) + ":" + (p.ownerPartId || p.id)
      ];
    setPatch(draft?.patch || p.patch);
    setNotes(draft?.notes || p.notes);
    setInstrumentName(draft?.name ?? p.name);
    setDirty(!!draft);
    setOctave(startingOctave(draft?.notes || p.notes));
    setEdit(null);
    setNoteSelection([]);
    setAssignmentTarget("");
    setSplitName("");
    matched.current.clear();
    setScore({ hit: 0, wrong: 0 });
  }
  async function save(assignment, source = part) {
    if (!source) return;
    const part = source;
    const sourceDraft =
      part.id === selected
        ? { patch, notes, name: instrumentName }
        : drafts.current[project.id + ":" + part.id] ||
          drafts.current[
            (part.ownerProjectId || project.id) +
              ":" +
              (part.ownerPartId || part.id)
          ] ||
          part;
    return savePart(assignment, part, sourceDraft);
  }
  async function savePart(assignment, part, sourceDraft) {
    const { patch, notes, name: instrumentName } = sourceDraft;
    const destinationPart = parts.find((p) => p.id === assignment?.targetId);
    const destinationDraft =
      destinationPart &&
      (destinationPart.id === selected && dirty
        ? {
            patch: latest.current.patch,
            notes: latest.current.notes,
            name: latest.current.instrumentName,
          }
        : drafts.current[project.id + ":" + destinationPart.id] ||
          drafts.current[
            (destinationPart.ownerProjectId || project.id) +
              ":" +
              (destinationPart.ownerPartId || destinationPart.id)
          ]);
    if (assignment?.action !== "merge" && destinationDraft) {
      const message =
        "Save the destination instrument's draft before moving notes into it.";
      setError(message);
      return { ok: false, error: message };
    }
    if (!instrumentName.trim()) {
      const message = "Enter an instrument name before saving.";
      setError(message);
      return { ok: false, error: message };
    }
    const projectId = project.id,
      partId = part.id,
      key = projectId + ":" + partId,
      snapshot = JSON.stringify({ patch, notes, name: instrumentName });
    setBusy(true);
    stop();
    if (assignment) setFeedback("Rebuilding reference stems…");
    setError("");
    try {
      const ownerId = part.ownerProjectId || projectId;
      const edited = await request(`/api/projects/${ownerId}/edit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: part.ownerRevision ?? project.revision,
          partId: part.ownerPartId || partId,
          patch,
          notes,
          name: instrumentName,
          targetEdit:
            assignment?.action === "merge" ? destinationDraft : undefined,
          assignment: assignment
            ? {
                ...assignment,
                targetId:
                  parts.find((p) => p.id === assignment.targetId)
                    ?.ownerPartId || assignment.targetId,
              }
            : undefined,
        }),
      });
      const saved = await request(`/api/projects/${projectId}`);
      saved.selectedPartId =
        ownerId === projectId
          ? edited.selectedPartId
          : `${ownerId}:${edited.selectedPartId}`;
      if (
        assignment?.action === "merge" ||
        JSON.stringify(drafts.current[key]) === snapshot
      ) {
        delete drafts.current[key];
        delete drafts.current[ownerId + ":" + (part.ownerPartId || partId)];
        try {
          localStorage.setItem(
            "melodics-instrument-drafts",
            JSON.stringify(drafts.current),
          );
        } catch {}
      }
      if (assignment?.action === "merge" && destinationDraft) {
        delete drafts.current[projectId + ":" + destinationPart.id];
        delete drafts.current[
          (destinationPart.ownerProjectId || projectId) +
            ":" +
            (destinationPart.ownerPartId || destinationPart.id)
        ];
        try {
          localStorage.setItem(
            "melodics-instrument-drafts",
            JSON.stringify(drafts.current),
          );
        } catch {}
      }
      const current = latest.current;
      if (current.project?.id === projectId) {
        setProject(saved);
        if (
          assignment &&
          (current.part?.id === partId || assignment.action === "merge")
        ) {
          // Controls were disabled during the transaction; no newer local edits
          // can be lost when selecting the destination returned by the server.
          const destination = saved.result.parts.find(
            (p) => p.id === saved.selectedPartId,
          );
          choose(destination);
          setExpandedId(destination.id);
          setMuted((items) =>
            items.filter((id) => saved.result.parts.some((p) => p.id === id)),
          );
          setSolo((items) =>
            [
              ...new Set(
                items.map((id) => (id === partId ? destination.id : id)),
              ),
            ].filter((id) => saved.result.parts.some((p) => p.id === id)),
          );
          audio.mixBuffers.clear();
          setDirty(false);
          setFeedback("Instrument assignments saved. Reference stems rebuilt.");
        }
        if (
          current.part?.id === partId &&
          JSON.stringify({
            patch: current.patch,
            notes: current.notes,
            name: current.instrumentName,
          }) === snapshot
        )
          setDirty(false);
      }
      return { ok: true };
    } catch (e) {
      setError(e.message);
      return { ok: false, error: e.message };
    } finally {
      setBusy(false);
    }
  }
  function stop() {
    playbackGeneration.current++;
    clearTimeout(loopTimer.current);
    audio.stop();
    activeKeys.current.clear();
    setPreparing(false);
    setPlaying(false);
    setHeld(new Set());
    setFeedback("Ready to play");
    transport.current = null;
  }
  async function play(options = {}) {
    window.dispatchEvent(new CustomEvent("lab-audition"));
    const scope = options.scope || "detail";
    const practice = scope === "detail" && tab === "practice";
    const fullMix = scope === "mix";
    const playingPart = options.part || part;
    const sourceMode =
      options.stemMode || stemModes[playingPart?.id] || "synth";
    const fullMixMode = options.mixMode || mixMode;
    const end = options.end ?? (scope === "mix" ? result.duration : range[1]);
    const lower = options.lower ?? (scope === "mix" ? 0 : range[0]);
    const cursor = options.offset ?? time;
    const offset = cursor >= end ? lower : clamp(cursor, lower, end);
    const activeIds = options.audible || audible;
    stop();
    setPlaybackScope(scope);
    setPlaybackPartId(fullMix ? null : playingPart.id);
    const generation = playbackGeneration.current;
    setPreparing(true);
    setTime(offset);
    setError("");
    try {
      if (practice) await audio.patch(playablePatch);
      if (generation !== playbackGeneration.current) return;
      let startAt;
      if (practice) {
        matched.current.clear();
        setScore({ hit: 0, wrong: 0 });
        setFeedback("Preparing accompaniment…");
        startAt = await audio.practice(
          playableParts.filter((p) => activeIds.has(p.id)),
          selected,
          offset,
          end,
          speed,
        );
      } else if (fullMix && fullMixMode === "original") {
        startAt = await audio.playUrl(
          apiPath(
            `/api/projects/${project.id}/audio/${result.sourceFile || "source.wav"}?v=${project.revision}`,
          ),
          offset,
          end,
        );
      } else if (fullMix) {
        startAt = await audio.playMix(
          parts.map((p) => ({
            id: p.id,
            url: apiPath(
              `/api/projects/${p.ownerProjectId || project.id}/audio/${p.synthFile}?v=${p.ownerRevision ?? project.revision}`,
            ),
          })),
          offset,
          end,
          activeIds,
        );
      } else {
        const file =
          sourceMode === "reference"
            ? playingPart.referenceFile
            : playingPart.synthFile;
        startAt = await audio.playUrl(
          apiPath(
            `/api/projects/${playingPart.ownerProjectId || project.id}/audio/${file}?v=${playingPart.ownerRevision ?? project.revision}`,
          ),
          offset,
          end,
        );
      }
      if (generation !== playbackGeneration.current || startAt === null) return;
      transport.current = {
        startAt,
        offset,
        scale: practice ? speed : 1,
        end,
        lower,
        practice,
        scope,
        partId: playingPart?.id,
      };
      setPlaying(true);
      if (practice) setFeedback("Get ready · 2 second count-in");
    } catch (e) {
      if (generation === playbackGeneration.current) setError(e.message);
    } finally {
      if (generation === playbackGeneration.current) setPreparing(false);
    }
  }
  useEffect(() => {
    if (!playing) return;
    let frame;
    const tick = () => {
      const tr = transport.current;
      if (!tr) return;
      const now =
        (audio.context.currentTime - tr.startAt) * tr.scale + tr.offset;
      setTime(Math.min(tr.end, Math.max(tr.offset, now)));
      if (now >= tr.end) {
        stop();
        if (loop)
          loopTimer.current = setTimeout(
            () =>
              latest.current.play({
                offset: tr.lower,
                scope: tr.scope,
                end: tr.end,
                lower: tr.lower,
                part: latest.current.parts.find((p) => p.id === tr.partId),
              }),
            100,
          );
        else if (tr.practice)
          setFeedback("Take complete · review your timing, then try again");
        return;
      }
      if (now < tr.offset && tr.practice)
        setFeedback(`Get ready · ${Math.ceil((tr.offset - now) / speed)}`);
      else if (tr.practice && !tr.started) {
        tr.started = true;
        setFeedback("Your turn · follow the notes");
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop, range, tab]);
  async function noteOn(pitch, velocity = 100, voiceId = String(pitch)) {
    if (latest.current.patch.engine === "drum")
      pitch = latest.current.notes[0]?.pitch ?? 36;
    const inputTime = audio.context?.currentTime,
      generation = playbackGeneration.current,
      s = latest.current,
      tr = transport.current;
    activeKeys.current.set(voiceId, pitch);
    setHeld(new Set(activeKeys.current.values()));
    try {
      await audio.on(pitch, velocity, voiceId);
    } catch (e) {
      setError(e.message);
      noteOff(pitch, voiceId);
      return;
    }
    if (generation !== playbackGeneration.current) return;
    if (s.playing && tr?.practice) {
      const t =
        ((inputTime ?? audio.context.currentTime) - tr.startAt) * tr.scale +
        tr.offset;
      const outcome = matchPracticeNote(
        s.notes,
        pitch,
        t,
        matched.current,
        s.range,
        s.speed,
      );
      if (outcome.kind === "hit") {
        matched.current.add(outcome.index);
        setScore((x) => ({ ...x, hit: x.hit + 1 }));
        setFeedback(outcome.feedback);
      } else if (outcome.kind === "extra") {
        setScore((x) => ({ ...x, wrong: x.wrong + 1 }));
        setFeedback("Listen for the next note");
      }
    } else setFeedback(noteName(pitch));
  }
  function noteOff(pitch, voiceId = String(pitch)) {
    audio.off(pitch, voiceId);
    activeKeys.current.delete(voiceId);
    setHeld(new Set(activeKeys.current.values()));
  }
  useEffect(() => {
    const mapping = "awsedftgyhujkolp;",
      pressed = new Map();
    const down = (e) => {
      if (
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)
      )
        return;
      const i = mapping.indexOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      const pitch = 12 * (latest.current.octave + 1) + i;
      pressed.set(e.code, pitch);
      noteOn(pitch);
    };
    const up = (e) => {
      const p = pressed.get(e.code);
      if (p !== undefined) {
        noteOff(p);
        pressed.delete(e.code);
      }
    };
    const blur = () => {
      for (const pitch of pressed.values()) noteOff(pitch);
      pressed.clear();
      audio.panic();
      activeKeys.current.clear();
      setHeld(new Set());
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    midiRef.current?.refresh();
  }, [deviceId]);
  async function connectMidi() {
    try {
      if (!navigator.requestMIDIAccess)
        throw new Error(
          "Web MIDI is unavailable in this browser. Use Chrome or the onscreen keyboard.",
        );
      const access = await navigator.requestMIDIAccess();
      midiRef.current?.dispose();
      midiRef.current = routeMidiInputs(access, {
        getDeviceId: () => latest.current.deviceId,
        onNoteOn: noteOn,
        onNoteOff: noteOff,
        onDevices: setDevices,
      });
      setFeedback("MIDI connected");
    } catch (e) {
      setError(e.message);
    }
  }
  const visiblePitches = notes
      .map((n) => Math.max(0, Math.min(127, Math.round(n.pitch))))
      .filter(Number.isFinite),
    lowestPitch = visiblePitches.length ? Math.min(...visiblePitches) : 60,
    highestPitch = visiblePitches.length ? Math.max(...visiblePitches) : 72,
    minPitch = Math.max(
      0,
      Math.min(
        lowestPitch - 2,
        Math.floor((lowestPitch + highestPitch - 12) / 2),
      ),
    ),
    maxPitch = Math.min(127, Math.max(highestPitch + 2, minPitch + 12));
  useEffect(() => {
    const viewport = rollViewport.current;
    if (!viewport || !notes.length) return;
    const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
    const middle = pitches[Math.floor(pitches.length / 2)];
    const height = Math.max(320, (maxPitch - minPitch + 1) * 16);
    viewport.scrollTop = Math.max(
      0,
      ((maxPitch - middle) / (maxPitch - minPitch + 1)) * height -
        viewport.clientHeight / 2,
    );
  }, [expandedId, selected]);
  const targetNotes = notes.filter(
    (n) => n.start >= range[0] && n.start < range[1],
  ).length;
  return (
    <div
      className={`instrument-lab-ui studio${embedded ? " native-editor" : ""}${isDrum ? " drum-editor" : ""}${result?.workspaceMix ? " combined-editor" : ""}`}
    >
      {!embedded && (
        <aside className="sidebar">
          <a className="brand" href={workspacePath}>
            m<span>elodics</span>
            <i>●</i>
          </a>
          <div className="workspace-label">YOUR WORKSPACE</div>
          <button className="nav-current">
            <span>◈</span> Instrument lab
          </button>
          <div className="library-title">
            RECORDINGS <span>{projects.length}</span>
          </div>
          <div className="project-list">
            {projects.map((p) => (
              <button
                key={p.id}
                className={p.id === project?.id ? "selected" : ""}
                onClick={() => open(p.id)}
                disabled={busy}
              >
                <span className="project-icon">≋</span>
                <span>
                  {p.title}
                  <small>
                    {p.status === "ready" ? "Ready to explore" : p.status}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <button
            className="sidebar-upload"
            onClick={() => {
              fileRef.current.click();
            }}
          >
            ＋ Import recording
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" /> Local analysis server
            <br />
            <small>Your audio stays on this server.</small>
          </div>
        </aside>
      )}
      <div className="main">
        <header className="topbar">
          {embedded ? (
            <>
              <button onClick={onExit} aria-label="Back to Melodics">
                ←
              </button>
              <div className="native-editor-title">
                <strong>{project?.title || "Instrument Lab"}</strong>
                <small>
                  Instrument Lab editor
                  {result
                    ? ` · ${parts.length} instruments · ${stamp(result.duration)}`
                    : ""}
                </small>
              </div>
              <select
                aria-label="Instrument Lab recording"
                value={project?.id || ""}
                onChange={(e) => open(e.target.value)}
                disabled={busy}
              >
                <option value="" disabled>
                  Choose a recording
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  fileRef.current.click();
                }}
                disabled={busy}
              >
                ＋ Import audio
              </button>
            </>
          ) : (
            <div>
              WORKSPACE <span>/</span> INSTRUMENT LAB
            </div>
          )}
          <button onClick={connectMidi}>
            ⌁ {devices.length ? "MIDI connected" : "Connect MIDI"}
          </button>
        </header>
        <main>
          {project && <DemucsSeparation key={project.id} project={project} busy={busy}
            onCreated={async p=>{stop();accept(p);await refresh();}}/>}
          {project && <AnalysisHistory project={project} projects={projects} busy={busy} onOpen={open}/>}
          {project && renderSourceEditor?.({project, projects, onAudition: stop})}
          {pendingAnalyses
            .filter((a) => a.id !== project.id)
            .map((a) => (
              <div className="review-notice" key={a.id}>
                Analyzing drum sounds · {a.message} ·{" "}
                {Math.round((a.progress || 0) * 100)}%
              </div>
            ))}
          {project?.analyses
            ?.filter(
              (a) =>
                a.id !== project.id &&
                ["error", "cancelled", "interrupted"].includes(a.status),
            )
            .map((a) => (
              <div className="error" key={a.id}>
                {a.message}
                <button
                  onClick={async () => {
                    try {
                      await request(`/api/projects/${a.id}/retry`, {
                        method: "POST",
                      });
                      await open(project.id);
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  Retry drum analysis
                </button>
              </div>
            ))}
          {!embedded && (
            <div className="page-heading">
              <div>
                <div className="eyebrow">INSTRUMENT LAB</div>
                <h1>{project?.title || "Recordings"}</h1>
                <p>
                  {result
                    ? `${parts.length} instrument${parts.length === 1 ? "" : "s"} · ${stamp(result.duration)} · ${result.analysis.notes} detected notes`
                    : "Select a recording or import audio."}
                </p>
              </div>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  fileRef.current.click();
                }}
              >
                ＋ Import audio
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".wav,.mp3,.flac,.ogg,.m4a,.aac"
            onChange={(e) => {
              upload(e.target.files[0]);
              e.target.value = "";
            }}
          />
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {!project && (
            <>
              <section
                className="welcome"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  upload(e.dataTransfer.files[0]);
                }}
              >
                <h2>Import a recording</h2>
                <p>
                  Choose or drop an audio file to analyze its synth and drum
                  instruments.
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    fileRef.current.click();
                  }}
                >
                  Choose a recording ↗
                </button>
                <small>WAV, MP3, FLAC, OGG, M4A · up to 60 MB</small>
              </section>
              <button className="demo-card" onClick={demo} disabled={busy}>
                <div className="demo-icon">▶</div>
                <div>
                  <strong>Analyze demo recording</strong>
                  <p>Neon duet · two synth instruments</p>
                </div>
                <span>Analyze demo →</span>
              </button>
            </>
          )}
          {project && !result && (
            <section className="progress-card">
              <div className="spinner">◈</div>
              <h2>
                {project.status === "ready"
                  ? "Loading instruments"
                  : project.message}
              </h2>
              <p>
                {["queued", "analyzing"].includes(project.status)
                  ? (project.demucsRequest ? "Separating with Demucs, splitting instruments, then fitting notes and patches." : project.samRequest ? "Separating on Hugging Face, then fitting one instrument per stem." : "Discovering sounds and notes directly from the recording.")
                  : "Your original audio is preserved."}
              </p>
              <progress value={project.progress || 0} max="1" />
              <div className="progress-meta">
                <span>{Math.round((project.progress || 0) * 100)}%</span>
                {["queued", "analyzing"].includes(project.status) ? (
                  <button
                    onClick={async () => {
                      setProject(
                        await request(`/api/projects/${project.id}/cancel`, {
                          method: "POST",
                        }),
                      );
                      refresh();
                    }}
                  >
                    Cancel analysis
                  </button>
                ) : (
                  <button
                    onClick={async () =>
                      setProject(
                        await request(`/api/projects/${project.id}/retry`, {
                          method: "POST",
                        }),
                      )
                    }
                  >
                    {project.samRequest && project.status !== "cancelled" && !["ERROR","CANCELED","CANCELLED","DELETED"].includes(project.remoteJob?.status) ? "Resume analysis" : "Retry analysis"}
                  </button>
                )}
              </div>
            </section>
          )}
          {result && (
            <>
              <div className="review-notice">
                <span>◉</span> Automatic first pass. Listen and review the
                instrument assignments before practising.
                <details>
                  <summary>Analysis details</summary>
                  {Number.isFinite(result.analysis.spectralResidual) && <p>
                    Spectral residual:{" "}
                    {Math.round(result.analysis.spectralResidual * 100)}% · this
                    is an error measure, not a sound-similarity score.
                  </p>}
                  {result.analysis.warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </details>
              </div>
              <Arrangement
                key={project.id}
                onAudition={stop}
                onAudioTime={setTime}
                onStartLesson={onStartLesson}
                parts={parts}
                duration={result.duration}
                selected={selected}
                colors={COLORS}
                time={time}
                active={(playing || preparing) && playbackScope === "mix"}
                preparing={preparing}
                busy={busy}
                muted={muted}
                solo={solo}
                onSeek={seek}
                onToggle={toggleMix}
                onMerge={(sourceId, targetId) =>
                  save(
                    { action: "merge", targetId },
                    parts.find((p) => p.id === sourceId),
                  )
                }
                expandedId={expandedId}
                mixMode={mixMode}
                onMixMode={(value) => {
                  setMixMode(value);
                  if ((playing || preparing) && playbackScope === "mix")
                    play({ scope: "mix", mixMode: value });
                }}
                onPlayPart={playLane}
                activePartId={
                  (playing || preparing) && playbackScope !== "mix"
                    ? playbackPartId
                    : null
                }
                onExpand={expandLane}
                onPlay={() =>
                  (playing || preparing) && playbackScope === "mix"
                    ? stop()
                    : play({ scope: "mix" })
                }
                renderDetail={({
                  start: viewStart,
                  span: viewSpan,
                  seekProps,
                  trackControls,
                }) =>
                  part && (
                    <section
                      className="instrument-detail inline-instrument-detail"
                      aria-label={`${part.name} expanded editor`}
                      style={{ "--track": color }}
                    >
                      <fieldset className="instrument-controls" disabled={busy}>
                        <div className="expanded-track-row mix-grid">
                          <div className="expanded-track-label">
                            {trackControls}
                          </div>
                          <div
                            className="expanded-roll-viewport"
                            ref={rollViewport}
                          >
                            <div
                              className="piano-roll"
                              style={{
                                height: Math.max(
                                  320,
                                  (maxPitch - minPitch + 1) * 16,
                                ),
                              }}
                            >
                              <div className="pitch-labels">
                                {Array.from(
                                  { length: maxPitch - minPitch + 1 },
                                  (_, i) => maxPitch - i,
                                )
                                  .filter((n) =>
                                    isDrum ? n === lowestPitch : n % 12 === 0,
                                  )
                                  .map((n) => (
                                    <span
                                      key={n}
                                      style={{
                                        top: `${((maxPitch - n) / (maxPitch - minPitch + 1)) * 100}%`,
                                      }}
                                    >
                                      {isDrum ? "Hit" : noteName(n)}
                                    </span>
                                  ))}
                              </div>
                              <div
                                className="note-grid"
                                data-timeline
                                {...seekProps}
                                aria-label={`Seek expanded ${part.name}`}
                                onPointerDown={(e) => {
                                  if (!e.target.closest("button"))
                                    seekProps.onPointerDown(e);
                                }}
                              >
                                {notes.map((n, i) =>
                                  n.end < viewStart ||
                                  n.start > viewStart + viewSpan ? null : (
                                    <button
                                      key={i}
                                      aria-label={`${isDrum ? "Hit" : noteName(n.pitch)} at ${n.start.toFixed(2)} seconds`}
                                      className={
                                        "note " +
                                        (noteSelection.includes(i)
                                          ? "selected "
                                          : "") +
                                        (matched.current.has(i) ? "hit" : "")
                                      }
                                      style={{
                                        left: `${((n.start - viewStart) / viewSpan) * 100}%`,
                                        width: `${Math.max(0.25, ((n.end - n.start) / viewSpan) * 100)}%`,
                                        top: `${((maxPitch - n.pitch) / (maxPitch - minPitch + 1)) * 100}%`,
                                        height: `${90 / (maxPitch - minPitch + 1)}%`,
                                      }}
                                      aria-pressed={
                                        tab === "notes"
                                          ? noteSelection.includes(i)
                                          : undefined
                                      }
                                      onKeyDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        setEdit(i);
                                        setNoteSelection(
                                          e.shiftKey
                                            ? (chosen) =>
                                                chosen.includes(i)
                                                  ? chosen.filter(
                                                      (index) => index !== i,
                                                    )
                                                  : [...chosen, i]
                                            : [i],
                                        );
                                        noteOn(n.pitch);
                                        setTimeout(() => noteOff(n.pitch), 250);
                                      }}
                                    />
                                  ),
                                )}
                                <div
                                  className="playhead"
                                  style={{
                                    left: `${((time - viewStart) / viewSpan) * 100}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="detail-header">
                          <div className="tabs">
                            {[
                              ["sound", "Shape sound"],
                              [
                                "notes",
                                isDrum ? "Review hits" : "Review notes",
                              ],
                              ["practice", "Practise"],
                            ].map(([key, label]) => (
                              <button
                                className={tab === key ? "active" : ""}
                                key={key}
                                onClick={() => {
                                  if (playbackScope !== "mix") stop();
                                  setTab(key);
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="transport">
                          <button
                            className="play"
                            aria-label={
                              (playing || preparing) &&
                              playbackScope !== "mix" &&
                              playbackPartId === selected
                                ? "Stop playback"
                                : "Start playback"
                            }
                            onClick={() =>
                              (playing || preparing) &&
                              playbackScope !== "mix" &&
                              playbackPartId === selected
                                ? stop()
                                : play()
                            }
                          >
                            {(playing || preparing) &&
                            playbackScope !== "mix" &&
                            playbackPartId === selected
                              ? preparing
                                ? "…"
                                : "■"
                              : "▶"}
                          </button>
                          <div className="time-display">
                            {stamp(time)} <small>/ {stamp(range[1])}</small>
                          </div>
                          {tab !== "practice" ? (
                            <div className="segmented">
                              {[
                                ["reference", "Original stem"],
                                ["synth", "Rebuilt stem"],
                              ].map(([key, label]) => (
                                <button
                                  key={key}
                                  className={mode === key ? "active" : ""}
                                  aria-pressed={mode === key}
                                  onClick={() => {
                                    setMode(key);
                                    if (
                                      (playing || preparing) &&
                                      playbackScope !== "mix" &&
                                      playbackPartId === selected
                                    )
                                      play({ scope: "stem", stemMode: key });
                                  }}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <>
                              <span className="practice-info">
                                {playbackScope === "mix" &&
                                (playing || preparing)
                                  ? "Full mix is playing · start this instrument to practise"
                                  : "Your instrument is muted in the backing"}
                              </span>
                              <select
                                aria-label="Practice speed"
                                value={speed}
                                onChange={(e) => {
                                  stop();
                                  setSpeed(Number(e.target.value));
                                }}
                              >
                                <option value=".5">50% speed</option>
                                <option value=".75">75% speed</option>
                                <option value="1">100% speed</option>
                              </select>
                            </>
                          )}
                          <button
                            className={loop ? "loop active" : "loop"}
                            aria-pressed={loop}
                            onClick={() => setLoop(!loop)}
                          >
                            ↻ Loop
                          </button>
                        </div>
                        {tab === "sound" && (
                          <div className="patch-panel">
                            <div className="patch-intro">
                              <label className="family-label">
                                Instrument name
                                <input
                                  aria-label="Instrument name"
                                  maxLength={80}
                                  value={instrumentName}
                                  onChange={(e) => {
                                    setInstrumentName(e.target.value);
                                    setDirty(true);
                                  }}
                                />
                              </label>
                              {!isDrum && (
                                <label className="family-label">
                                  Sound engine
                                  <select
                                    value={patch.family}
                                    onChange={(e) => {
                                      setPatch({
                                        ...patch,
                                        family: e.target.value,
                                      });
                                      setDirty(true);
                                    }}
                                  >
                                    {FAMILIES.map((f) => (
                                      <option key={f}>{f}</option>
                                    ))}
                                  </select>
                                </label>
                              )}
                            </div>
                            {isDrum && (
                              <div className="drum-explanation">
                                <strong>Hybrid drum engine</strong>
                                <p>
                                  Recovered detail keeps the recording’s
                                  texture. Set it to zero to hear only the
                                  fitted resonator and noise synthesis.
                                </p>
                                <label>
                                  Choke group{" "}
                                  <input
                                    aria-label="Choke group"
                                    value={patch.chokeGroup || ""}
                                    onChange={(e) => {
                                      setPatch({
                                        ...patch,
                                        chokeGroup: e.target.value,
                                      });
                                      setDirty(true);
                                    }}
                                    placeholder="e.g. hats"
                                  />
                                </label>
                                <small>
                                  Sounds in the same group cut each other off.
                                  Leave blank for overlapping tails.
                                </small>
                                {part.discovery?.needsReview && (
                                  <p>
                                    Overlapping sounds may remain in this
                                    example. Compare the original before
                                    practising.
                                  </p>
                                )}
                              </div>
                            )}
                            <div className="controls">
                              {(isDrum
                                ? Object.entries(DRUM_LABELS)
                                : [
                                    ["brightness", "Brightness"],
                                    ["body", "Body"],
                                    ["attack", "Attack"],
                                    ["decay", "Decay"],
                                    ["sustain", "Sustain"],
                                    ["release", "Release"],
                                    ...(patch.family === "fm"
                                      ? [
                                          ["fm", "FM amount"],
                                          ["ratio", "FM ratio"],
                                        ]
                                      : patch.family === "pulse"
                                        ? [["odd", "Pulse width"]]
                                        : []),
                                    ["detune", "Detune"],
                                    ["gain", "Level"],
                                  ]
                              ).map(([key, label]) => (
                                <label className="parameter" key={key}>
                                  <span>
                                    {label}
                                    <output>
                                      {!isDrum &&
                                      ["attack", "decay", "release"].includes(
                                        key,
                                      )
                                        ? `${Math.round(patch[key] * 1000)} ms`
                                        : key === "detune"
                                          ? `${patch[key].toFixed(0)} ct`
                                          : patch[key].toFixed(2)}
                                    </output>
                                  </span>
                                  <input
                                    aria-label={label}
                                    type="range"
                                    min={
                                      (isDrum ? DRUM_PARAMS : PARAMS)[key][0]
                                    }
                                    max={
                                      (isDrum ? DRUM_PARAMS : PARAMS)[key][1]
                                    }
                                    step={key === "ratio" ? 1 : 0.001}
                                    value={patch[key]}
                                    onChange={(e) => {
                                      setPatch({
                                        ...patch,
                                        [key]: Number(e.target.value),
                                      });
                                      setDirty(true);
                                    }}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {tab !== "sound" && (
                          <>
                            <div className="roll-toolbar">
                              <span>
                                {tab === "practice"
                                  ? isDrum
                                    ? "Follow the playhead. Play each hit as it arrives."
                                    : "Follow the playhead. Play each note as it arrives."
                                  : isDrum
                                    ? "Click a hit to edit its timing and velocity."
                                    : "Click a note to edit it. Shift-click to select more."}
                              </span>
                              <label>
                                From{" "}
                                <input
                                  aria-label="Loop start"
                                  type="number"
                                  min="0"
                                  max={range[1] - 0.1}
                                  step=".1"
                                  value={range[0]}
                                  onChange={(e) => {
                                    stop();
                                    setRange([
                                      Math.max(
                                        0,
                                        Math.min(
                                          range[1] - 0.1,
                                          Number(e.target.value),
                                        ),
                                      ),
                                      range[1],
                                    ]);
                                  }}
                                />
                              </label>
                              <label>
                                To{" "}
                                <input
                                  aria-label="Loop end"
                                  type="number"
                                  min={range[0] + 0.1}
                                  max={result.duration}
                                  step=".1"
                                  value={range[1]}
                                  onChange={(e) => {
                                    stop();
                                    setRange([
                                      range[0],
                                      Math.min(
                                        result.duration,
                                        Math.max(
                                          range[0] + 0.1,
                                          Number(e.target.value),
                                        ),
                                      ),
                                    ]);
                                  }}
                                />
                              </label>
                            </div>
                            {tab === "notes" && (
                              <div className="add-note-row">
                                <button
                                  onClick={() => {
                                    const start = Math.min(
                                      Math.max(0, time),
                                      result.duration - 0.1,
                                    );
                                    setNotes([
                                      ...notes,
                                      {
                                        pitch: isDrum
                                          ? (notes[0]?.pitch ?? 36)
                                          : (octave + 1) * 12,
                                        start,
                                        end: Math.min(
                                          result.duration,
                                          start + 0.25,
                                        ),
                                        velocity: 90,
                                        confidence: 1,
                                        edited: true,
                                      },
                                    ]);
                                    setEdit(notes.length);
                                    setNoteSelection([notes.length]);
                                    setDirty(true);
                                  }}
                                >
                                  {isDrum
                                    ? "＋ Add hit at playhead"
                                    : "＋ Add note at playhead"}
                                </button>
                                <button
                                  onClick={() =>
                                    setNoteSelection(
                                      notes.flatMap((n, i) =>
                                        n.start >= range[0] &&
                                        n.start < range[1]
                                          ? [i]
                                          : [],
                                      ),
                                    )
                                  }
                                >
                                  {isDrum
                                    ? "Select hits in loop"
                                    : "Select notes in loop"}
                                </button>
                                <button
                                  disabled={!noteSelection.length}
                                  onClick={() => setNoteSelection([])}
                                >
                                  Clear selection
                                </button>
                              </div>
                            )}
                            {tab === "notes" &&
                              edit !== null &&
                              notes[edit] && (
                                <div className="note-editor">
                                  {[
                                    ...(!isDrum
                                      ? [["pitch", "MIDI pitch"]]
                                      : []),
                                    ["start", "Start (s)"],
                                    ...(!isDrum ? [["end", "End (s)"]] : []),
                                    ["velocity", "Velocity"],
                                  ].map(([key, label]) => (
                                    <label key={key}>
                                      {label}
                                      <input
                                        type="number"
                                        aria-label={label}
                                        step={
                                          key === "pitch" || key === "velocity"
                                            ? 1
                                            : 0.01
                                        }
                                        value={notes[edit][key]}
                                        onChange={(e) => {
                                          setNotes(
                                            notes.map((n, i) =>
                                              i === edit
                                                ? {
                                                    ...n,
                                                    [key]: Number(
                                                      e.target.value,
                                                    ),
                                                    ...(isDrum &&
                                                    key === "start"
                                                      ? {
                                                          start: Math.max(
                                                            0,
                                                            Math.min(
                                                              result.duration -
                                                                0.001,
                                                              Number(
                                                                e.target.value,
                                                              ),
                                                            ),
                                                          ),
                                                          end: Math.min(
                                                            result.duration,
                                                            Math.max(
                                                              0,
                                                              Number(
                                                                e.target.value,
                                                              ),
                                                            ) + 0.06,
                                                          ),
                                                        }
                                                      : {}),
                                                  }
                                                : n,
                                            ),
                                          );
                                          setDirty(true);
                                        }}
                                      />
                                    </label>
                                  ))}
                                  <button
                                    onClick={() => {
                                      setNotes(
                                        notes.filter((_, i) => i !== edit),
                                      );
                                      setEdit(null);
                                      setNoteSelection([]);
                                      setDirty(true);
                                    }}
                                  >
                                    {isDrum ? "Delete hit" : "Delete note"}
                                  </button>
                                </div>
                              )}
                            {tab === "notes" && !isDrum && !result.separation && (
                              <details className="assignment-editor lane-tools">
                                <summary>Split, move or merge notes</summary>
                                <div>
                                  <strong>
                                    {noteSelection.length}{" "}
                                    {noteSelection.length === 1
                                      ? "note"
                                      : "notes"}{" "}
                                    selected
                                  </strong>
                                  <p>
                                    Correct which instrument plays these notes.
                                    Each change rebuilds the reference stems and
                                    saves your current edits.
                                  </p>
                                </div>
                                <div className="assignment-actions">
                                  <label>
                                    New instrument name
                                    <input
                                      aria-label="New instrument name"
                                      value={splitName}
                                      placeholder={instrumentName + " · split"}
                                      onChange={(e) =>
                                        setSplitName(e.target.value)
                                      }
                                      maxLength={80}
                                    />
                                  </label>
                                  <button
                                    disabled={
                                      !noteSelection.length ||
                                      noteSelection.length >= notes.length
                                    }
                                    onClick={() =>
                                      save({
                                        action: "split",
                                        indexes: noteSelection,
                                        name: splitName,
                                      })
                                    }
                                  >
                                    Split selected into new instrument
                                  </button>
                                </div>
                                {parts.length > 1 && (
                                  <>
                                    <div className="assignment-actions">
                                      <label>
                                        Destination instrument
                                        <select
                                          aria-label="Destination instrument"
                                          value={assignmentTarget}
                                          onChange={(e) =>
                                            setAssignmentTarget(e.target.value)
                                          }
                                        >
                                          <option value="">
                                            Choose an instrument…
                                          </option>
                                          {parts
                                            .filter(
                                              (p) =>
                                                p.id !== selected &&
                                                p.ownerProjectId ===
                                                  part.ownerProjectId,
                                            )
                                            .map((p) => (
                                              <option key={p.id} value={p.id}>
                                                {p.name}
                                              </option>
                                            ))}
                                        </select>
                                      </label>
                                      <button
                                        disabled={
                                          !assignmentTarget ||
                                          !noteSelection.length
                                        }
                                        onClick={() =>
                                          save({
                                            action: "move",
                                            targetId: assignmentTarget,
                                            indexes: noteSelection,
                                          })
                                        }
                                      >
                                        Move selected notes
                                      </button>
                                      <button
                                        disabled={!assignmentTarget}
                                        onClick={() =>
                                          save({
                                            action: "merge",
                                            targetId: assignmentTarget,
                                          })
                                        }
                                      >
                                        Merge whole instrument
                                      </button>
                                    </div>
                                    <small>
                                      Merge keeps the destination sound and
                                      removes this instrument row. Use it when
                                      both rows belong to the same instrument.
                                    </small>
                                  </>
                                )}
                              </details>
                            )}
                            {tab === "practice" && (
                              <div className="scoreboard">
                                <strong>{feedback}</strong>
                                <span>
                                  <b>{score.hit}</b> / {targetNotes}{" "}
                                  {isDrum ? "hits played" : "notes hit"}
                                </span>
                                <span>
                                  <b>{score.wrong}</b> extra{" "}
                                  {isDrum ? "hits" : "notes"}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                        <details
                          className="lane-audition"
                          key={`${selected}:${tab}`}
                          open={tab !== "notes"}
                        >
                          <summary>
                            Audition instrument · keyboard and MIDI
                          </summary>
                          {isDrum ? (
                            <div className="drum-pad-panel">
                              <button
                                className={
                                  held.size ? "drum-pad held" : "drum-pad"
                                }
                                onPointerDown={(e) => {
                                  e.currentTarget.setPointerCapture(
                                    e.pointerId,
                                  );
                                  noteOn(notes[0]?.pitch ?? 36);
                                }}
                                onPointerUp={() =>
                                  noteOff(notes[0]?.pitch ?? 36)
                                }
                                onPointerCancel={() =>
                                  noteOff(notes[0]?.pitch ?? 36)
                                }
                              >
                                Play {instrumentName}
                                <small>A key · any MIDI pad</small>
                              </button>
                              <p>
                                One-shot playback follows hit velocity.
                                Releasing a pad keeps the tail ringing.
                              </p>
                            </div>
                          ) : (
                            <div className="keyboard-panel">
                              <div className="keyboard-caption">
                                <span>
                                  PLAY THIS INSTRUMENT{" "}
                                  <small>
                                    {tab === "practice"
                                      ? "Timing window ±150 ms"
                                      : feedback}
                                  </small>
                                </span>
                                <div>
                                  <button
                                    aria-label="Lower octave"
                                    onClick={() =>
                                      setOctave(Math.max(0, octave - 1))
                                    }
                                  >
                                    −
                                  </button>
                                  <span>Octave {octave}</span>
                                  <button
                                    aria-label="Higher octave"
                                    onClick={() =>
                                      setOctave(Math.min(7, octave + 1))
                                    }
                                  >
                                    ＋
                                  </button>
                                  {devices.length > 0 && (
                                    <select
                                      aria-label="MIDI device"
                                      value={deviceId}
                                      onChange={(e) =>
                                        setDeviceId(e.target.value)
                                      }
                                    >
                                      <option value="">All MIDI devices</option>
                                      {deviceId &&
                                        !devices.some(
                                          (d) => d.id === deviceId,
                                        ) && (
                                          <option value={deviceId}>
                                            Disconnected device
                                          </option>
                                        )}
                                      {devices.map((d) => (
                                        <option key={d.id} value={d.id}>
                                          {d.name}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </div>
                              </div>
                              <div className="keyboard">
                                {Array.from({ length: 25 }, (_, i) => {
                                  const pitch = (octave + 1) * 12 + i,
                                    black = [1, 3, 6, 8, 10].includes(
                                      pitch % 12,
                                    );
                                  return (
                                    <button
                                      key={pitch}
                                      aria-label={"Play " + noteName(pitch)}
                                      className={
                                        (black ? "black" : "white") +
                                        (held.has(pitch) ? " held" : "")
                                      }
                                      onPointerDown={(e) => {
                                        e.currentTarget.setPointerCapture(
                                          e.pointerId,
                                        );
                                        noteOn(pitch);
                                      }}
                                      onPointerUp={() => noteOff(pitch)}
                                      onPointerCancel={() => noteOff(pitch)}
                                    >
                                      <span>
                                        {i % 12 === 0 ? noteName(pitch) : ""}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              <small className="key-hint">
                                Use your MIDI keyboard, click the keys, or play
                                with A W S E D F T G Y H U J.
                              </small>
                            </div>
                          )}
                        </details>
                        <div className="detail-footer">
                          <span>
                            {dirty
                              ? "Unsaved changes"
                              : isDrum
                                ? "Patch and hits saved"
                                : "Patch and notes saved"}{" "}
                            · <small>Original analysis is preserved</small>
                          </span>
                          <div>
                            <button
                              onClick={() => {
                                setPatch(part.automaticPatch);
                                setDirty(true);
                              }}
                            >
                              Reset sound
                            </button>
                            <button
                              className="primary"
                              disabled={busy || !dirty}
                              onClick={() => save()}
                            >
                              {busy ? "Saving…" : "Save instrument"}
                            </button>
                          </div>
                        </div>
                      </fieldset>
                    </section>
                  )
                }
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
