#![allow(dead_code)]
#![allow(unused_imports)]
use log::{info, warn};
use std::path::Path;

/// ORC format is handled by the Python converter daemon.
/// This module manages the ORC directory structure and delegates
/// actual ORC writing to Python (via the converter.py background daemon).
///
/// Flow: Rust writes binary → Python reads binary → Python writes ORC + Parquet
pub struct OrcDB {
    base_path: String,
}

impl OrcDB {
    pub fn new(base_path: &str) -> Self {
        let orc_path = format!("{}/orc", base_path);
        let path = Path::new(&orc_path);
        if !path.exists() {
            let _ = std::fs::create_dir_all(path);
        }
        // Create subdirectories
        let _ = std::fs::create_dir_all(Path::new(&format!("{}/agents", orc_path)));
        let _ = std::fs::create_dir_all(Path::new(&format!("{}/history", orc_path)));
        
        info!("[ORC] Directory initialized at {}", orc_path);
        Self {
            base_path: orc_path,
        }
    }

    /// Check if ORC history files exist (written by Python converter daemon)
    pub fn has_history(&self) -> bool {
        let paper = format!("{}/history/paper_trades.orc", self.base_path);
        let shadow = format!("{}/history/shadow_trades.orc", self.base_path);
        Path::new(&paper).exists() || Path::new(&shadow).exists()
    }

    pub fn history_path(&self) -> String {
        format!("{}/history", self.base_path)
    }

    pub fn agents_path(&self) -> String {
        format!("{}/agents", self.base_path)
    }
}
