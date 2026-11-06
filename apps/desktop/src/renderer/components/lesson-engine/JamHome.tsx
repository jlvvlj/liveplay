import './JamLobby.css';

// The jam app's home: its sections, the Daw (songs made on the grid,
// together), the Jam (rooms playing a song on the highway) and Lessons (rooms
// where one track of the song comes at the ship to be played in time)

interface JamHomeProps {
  // How many songs, Jam rooms and lesson rooms there are; null until the server first answers
  songs: number | null;
  rooms: number | null;
  lessons: number | null;
  onOpen: (section: 'daw' | 'jam' | 'lessons') => void;
}

const count = (n: number | null, one: string, many: string) => (n === null ? '' : `${n} ${n === 1 ? one : many}`);

export function JamHome({ songs, rooms, lessons, onOpen }: JamHomeProps) {
  return (
    <div className="jam-lobby jam-home">
      <div className="jam-home-sections">
        <button className="jam-lobby-card jam-home-card" onClick={() => onOpen('daw')}>
          <span className="jam-home-name">Daw</span>
          <span className="jam-home-count">{count(songs, 'song', 'songs')}</span>
        </button>
        <button className="jam-lobby-card jam-home-card" onClick={() => onOpen('jam')}>
          <span className="jam-home-name">Jam</span>
          <span className="jam-home-count">{count(rooms, 'room', 'rooms')}</span>
        </button>
        <button className="jam-lobby-card jam-home-card" onClick={() => onOpen('lessons')}>
          <span className="jam-home-name">Lessons</span>
          <span className="jam-home-count">{count(lessons, 'room', 'rooms')}</span>
        </button>
      </div>
    </div>
  );
}
