use serde::Serialize;

/// Errors returned to the webview. Messages are short, uppercase-safe and never contain secrets or paths
/// beyond the app's own data directory.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("INVALID INPUT: {0}")]
    Invalid(String),
    #[error("STORAGE: {0}")]
    Io(#[from] std::io::Error),
    #[error("FORMAT: {0}")]
    Json(#[from] serde_json::Error),
    #[error("WINDOW: {0}")]
    Window(String),
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Window(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
