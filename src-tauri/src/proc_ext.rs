//! Process spawning helpers.
//!
//! The release binary is a GUI-subsystem app (no console). Any child process
//! spawned without `CREATE_NO_WINDOW` gets its own console window on Windows —
//! which is why installed builds flashed a terminal on every ffmpeg/ffprobe/
//! whisper call. All `Command` creation goes through `silent`.

/// `Command` with `CREATE_NO_WINDOW` on Windows so child binaries never open
/// a console window. No-op flag on other platforms.
pub fn silent<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}
