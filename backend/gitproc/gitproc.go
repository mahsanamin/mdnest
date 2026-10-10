// Package gitproc builds git commands that talk to a remote, so that a stalled
// remote cannot block the caller forever.
package gitproc

import (
	"context"
	"os/exec"
	"time"
)

// waitDelay bounds how long Wait keeps reading output pipes after git exits or
// is killed, in case a helper outlived it while still holding them.
const waitDelay = 5 * time.Second

// Command is exec.CommandContext("git", args...) for network operations. When
// ctx ends, the whole process group is killed, not just git: the transport
// helpers git spawns (git-remote-https, ssh) hold the socket and git's output
// pipes, and would otherwise keep Wait (and the caller) blocked forever.
func Command(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	killProcessGroupOnCancel(cmd)
	cmd.WaitDelay = waitDelay
	return cmd
}
