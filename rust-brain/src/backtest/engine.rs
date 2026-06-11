#![allow(dead_code)]
#![allow(unused_imports)]
use log::info;
use std::path::Path;

pub struct BacktestEngine {
    db_path: String,
}

impl BacktestEngine {
    pub fn new(db_path: &str) -> Self {
        Self {
            db_path: db_path.to_string(),
        }
    }

    /// Read historical data from Parquet/ORC and stream it into the Agent Training Room.
    pub fn stream_historical_data(&self, pair: &str, start_ts: i64, end_ts: i64) -> anyhow::Result<()> {
        info!("[Backtest] Initiating historical stream for {} ({} -> {})", pair, start_ts, end_ts);
        
        let file_path = format!("{}/bigdata_unfiltered/{}_bigdata.parquet", self.db_path, pair);
        if !Path::new(&file_path).exists() {
            info!("[Backtest] No local data found for {}. Please trigger DownloadCandles.", pair);
            return Ok(());
        }

        // TODO: Read Parquet efficiently using Arrow and pass it tick-by-tick or chunk-by-chunk 
        // to the training environment (ROOMS PENDIDIKAN MILITER TATAR).
        
        info!("[Backtest] Finished streaming historical data for {}.", pair);
        Ok(())
    }
}
