function PresenceBar({ users, currentUserId, typingUsers }) {
  // Filter out current user
  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return null;

  // Who is currently typing (from typingUsers map: {userId: username})
  const typingNames = Object.values(typingUsers || {}).filter(Boolean);

  return (
    <div className="presence-bar" title={`${others.map((u) => u.username).join(', ')} ${others.length === 1 ? 'is' : 'are'} also here`}>
      {others.map((u) => {
        const isTyping = typingUsers && typingUsers[u.id];
        return (
          <div
            key={u.id}
            className={`presence-dot${isTyping ? ' typing' : ''}`}
            style={{ backgroundColor: u.color }}
            title={u.username + (isTyping ? ' (typing)' : '')}
          >
            {u.username.slice(0, 1).toUpperCase()}
          </div>
        );
      })}
      {/* Initials only, names in the tooltip, so the toolbar keeps its
          width; words appear only while someone is typing. */}
      {typingNames.length > 0 && (
        <span className="presence-label">
          {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing<span className="typing-dots">...</span>
        </span>
      )}
    </div>
  );
}

export default PresenceBar;
