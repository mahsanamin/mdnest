//go:build !unix

package gitproc

import "os/exec"

// Without process groups only git itself is killed; WaitDelay still bounds Wait.
func killProcessGroupOnCancel(*exec.Cmd) {}
