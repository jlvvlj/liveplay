import type { JamInvite } from './jamLobbyConnection';
import { CloseIcon } from './JamIcons';
import './JamInvites.css';

// Invites this player got, wherever they are in the app: who invites them
// to which song, to join or to put away
export function JamInvites({ invites, onJoin, onDismiss }: { invites: JamInvite[]; onJoin: (invite: JamInvite) => void; onDismiss: (invite: JamInvite) => void }) {
  if (!invites.length) return null;
  return (
    <div className="jam-invites" role="status">
      {invites.map((invite, i) => (
        <div key={i} className="jam-invite">
          <span className="jam-invite-text">
            <b>{invite.from.name || 'A player'}</b> invites you to <b>{invite.title}</b>
          </span>
          <button className="jam-invite-join" onClick={() => onJoin(invite)}>
            Join
          </button>
          <button className="jam-invite-close" onClick={() => onDismiss(invite)} title="Close">
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
