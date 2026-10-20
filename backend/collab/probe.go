package collab

// NewProbeConn returns a connection with no socket behind it, for tests in
// other packages that need to see what the hub sends to someone in a note.
// TakeQueued drains what was sent to it.
func NewProbeConn(userID int, username string) *Conn {
	return NewConn(nil, userID, username)
}

// TakeQueued returns and removes every message queued for this connection.
func (c *Conn) TakeQueued() [][]byte {
	var out [][]byte
	for {
		select {
		case m := <-c.send:
			out = append(out, m)
		default:
			return out
		}
	}
}
