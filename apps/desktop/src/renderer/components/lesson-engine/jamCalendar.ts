// A session planned together: an event for Google Calendar (a link that
// opens it filled in) or for any other calendar (an .ics file), with the
// song's link and the invited players' emails as guests.

export interface JamSession {
  title: string;
  // The song's or the room's link
  link: string;
  start: Date;
  minutes: number;
  guests: string[];
}

// 20261113T190000Z: a moment in UTC as both formats write it
const utc = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const endOf = ({ start, minutes }: JamSession) => new Date(start.getTime() + minutes * 60000);

export function googleCalendarUrl(session: JamSession): string {
  const query = new URLSearchParams({
    action: 'TEMPLATE',
    text: session.title,
    dates: `${utc(session.start)}/${utc(endOf(session))}`,
    details: session.link,
  });
  if (session.guests.length) query.set('add', session.guests.join(','));
  return `https://calendar.google.com/calendar/render?${query}`;
}

// Text in an .ics field: its backslashes, commas, semicolons and line breaks escaped
const icsText = (text: string) => text.replace(/[\\,;]/g, (char) => `\\${char}`).replace(/\r?\n/g, '\\n');

export function icsFile(session: JamSession, uid: string, now = new Date()): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Melodics//Jam//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(session.start)}`,
    `DTEND:${utc(endOf(session))}`,
    `SUMMARY:${icsText(session.title)}`,
    `DESCRIPTION:${icsText(session.link)}`,
    `URL:${session.link}`,
    ...session.guests.map((email) => `ATTENDEE;RSVP=TRUE:mailto:${email}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// The days a session can be planned on: today and the next two weeks
export function sessionDays(now = new Date(), count = 14): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
}

// A session's start times in a day: every half hour, as minutes since midnight
export const SESSION_TIMES = Array.from({ length: 48 }, (_, i) => i * 30);
export const SESSION_LENGTHS = [30, 60, 90, 120];

// The next half hour from now, as minutes since midnight (past the day's last, its last)
export function nextHalfHour(now = new Date()): number {
  return Math.min(Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30, 23 * 60 + 30);
}
