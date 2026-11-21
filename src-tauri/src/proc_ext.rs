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

/// Open a URL in the default browser without flashing a console.
/// `webbrowser` spawns `cmd /c start` on Windows — its own child Command,
/// not routed through `silent` — so each open flashes a terminal window.
/// `explorer.exe` is a GUI-subsystem process and opens URLs natively.
pub fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        silent("explorer").arg(url).spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        webbrowser::open(url).map_err(|e| std::io::Error::other(e.to_string()))
    }
}
