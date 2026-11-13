/**
 * @jest-environment node
 */
import { googleCalendarUrl, icsFile, nextHalfHour, type JamSession } from '../apps/desktop/src/renderer/components/lesson-engine/jamCalendar';

const SESSION: JamSession = {
  title: 'Play Softer Export, with me',
  link: 'https://jam.example/?song=SNHY49SF',
  start: new Date(Date.UTC(2026, 10, 14, 18, 30)),
  minutes: 90,
  guests: ['ana@example.com', 'ben@example.com'],
};

describe('planning a session', () => {
  it('opens Google Calendar with the event filled in', () => {
    const query = new URL(googleCalendarUrl(SESSION)).searchParams;
    expect(query.get('action')).toBe('TEMPLATE');
    expect(query.get('text')).toBe(SESSION.title);
    expect(query.get('dates')).toBe('20261114T183000Z/20261114T200000Z');
    expect(query.get('details')).toBe(SESSION.link);
    expect(query.get('add')).toBe('ana@example.com,ben@example.com');
    expect(new URL(googleCalendarUrl({ ...SESSION, guests: [] })).searchParams.has('add')).toBe(false);
  });

  it('writes an .ics event with its guests, its text escaped', () => {
    const ics = icsFile(SESSION, 'uid-1', new Date(Date.UTC(2026, 10, 13, 9, 0)));
    const lines = ics.split('\r\n');
    expect(lines).toContain('DTSTART:20261114T183000Z');
    expect(lines).toContain('DTEND:20261114T200000Z');
    expect(lines).toContain('DTSTAMP:20261113T090000Z');
    expect(lines).toContain('SUMMARY:Play Softer Export\\, with me');
    expect(lines).toContain('ATTENDEE;RSVP=TRUE:mailto:ben@example.com');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
  });

  it('starts at the next half hour', () => {
    expect(nextHalfHour(new Date(2026, 0, 1, 18, 10))).toBe(18 * 60 + 30);
    expect(nextHalfHour(new Date(2026, 0, 1, 18, 30))).toBe(19 * 60);
    expect(nextHalfHour(new Date(2026, 0, 1, 23, 50))).toBe(23 * 60 + 30);
  });
});
