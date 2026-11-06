import './JamLobby.css';

// The jam app's home: its two sections, the Daw (songs made on the grid,
// together) and the Jam (rooms playing a song on the highway)

interface JamHomeProps {
  // How many songs and live rooms there are; null until the server first answers
  songs: number | null;
  rooms: number | null;
  onOpen: (section: 'daw' | 'jam') => void;
}

const count = (n: number | null, one: string, many: string) => (n === null ? '' : `${n} ${n === 1 ? one : many}`);

export function JamHome({ songs, rooms, onOpen }: JamHomeProps) {
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
      </div>
    </div>
  );
}
