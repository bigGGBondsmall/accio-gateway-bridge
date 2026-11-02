//go:build windows

package main

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	killJobOnce sync.Once
	killJob     windows.Handle
	killJobErr  error
)

// processKillOnCloseJob returns a process-wide job object configured with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. The handle is intentionally never
// closed: the OS closes it when this process exits (normally or not), which
// terminates every process assigned to the job.
func processKillOnCloseJob() (windows.Handle, error) {
	killJobOnce.Do(func() {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			killJobErr = err
			return
		}
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info))); err != nil {
			_ = windows.CloseHandle(job)
			killJobErr = err
			return
		}
		killJob = job
	})
	return killJob, killJobErr
}

// pidAlive reports whether a process with this pid currently exists.
func pidAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// Access denied still means the process exists.
		return err == windows.ERROR_ACCESS_DENIED
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	const stillActive = 259
	return code == stillActive
}

// attachKillOnCloseJob assigns pid to the kill-on-close job so the managed
// bridge never outlives the desktop app.
func attachKillOnCloseJob(pid int) error {
	job, err := processKillOnCloseJob()
	if err != nil {
		return err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	return windows.AssignProcessToJobObject(job, h)
}
