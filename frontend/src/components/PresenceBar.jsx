function PresenceBar({ users, currentUserId, typingUsers }) {
  // Filter out current user
  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return null;

  // Who is currently typing (from typingUsers map: {userId: username})
  const typingNames = Object.values(typingUsers || {}).filter(Boolean);

  return (
    <div className="presence-bar">
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
      <span className="presence-label">
        {typingNames.length > 0 ? (
          <>{typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing<span className="typing-dots">...</span></>
        ) : (
          <>{others.map((u) => u.username).join(', ')} {others.length === 1 ? 'is' : 'are'} also here</>
        )}
      </span>
    </div>
  );
}

export default PresenceBar;
