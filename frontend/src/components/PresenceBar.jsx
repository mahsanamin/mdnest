function PresenceBar({ users, currentUserId }) {
  // Filter out current user
  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return null;

  return (
    <div className="presence-bar">
      {others.map((u) => (
        <div
          key={u.id}
          className="presence-dot"
          style={{ backgroundColor: u.color }}
          title={u.username}
        >
          {u.username.slice(0, 1).toUpperCase()}
        </div>
      ))}
      <span className="presence-label">
        {others.map((u) => u.username).join(', ')} {others.length === 1 ? 'is' : 'are'} also here
      </span>
    </div>
  );
}

export default PresenceBar;
