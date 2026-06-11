#![allow(dead_code)]
#![allow(unused_imports)]
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex};
use arrow::array::{Float64Array, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::file::properties::WriterProperties;
use parquet::basic::Compression;
use log::{info, warn, error};

/// BigData tick buffer config
const BUFFER_FLUSH_SIZE: usize = 5000;     // Flush when buffer hits 5000 ticks per symbol
const BUFFER_FLUSH_INTERVAL_S: u64 = 30;   // Or flush every 30 seconds

/// In-memory tick buffer for efficient batched Parquet writes
#[derive(Debug, Default)]
struct TickBuffer {
    timestamps: Vec<i64>,
    prices: Vec<f64>,
    volumes: Vec<f64>,
    last_flush_ts: i64,
}

impl TickBuffer {
    fn len(&self) -> usize {
        self.timestamps.len()
    }

    fn push(&mut self, ts: i64, price: f64, volume: f64) {
        self.timestamps.push(ts);
        self.prices.push(price);
        self.volumes.push(volume);
    }

    fn drain(&mut self) -> (Vec<i64>, Vec<f64>, Vec<f64>) {
        let ts = std::mem::take(&mut self.timestamps);
        let px = std::mem::take(&mut self.prices);
        let vol = std::mem::take(&mut self.volumes);
        self.last_flush_ts = 0; // reset
        (ts, px, vol)
    }
}

pub struct ParquetDB {
    ticks_path: String,
    candles_path: String,
    /// Per-symbol tick buffers for efficient batched writes
    buffers: Mutex<HashMap<String, TickBuffer>>,
    /// Stats tracking
    total_ticks_written: Mutex<u64>,
}

impl ParquetDB {
    pub fn new(base_path: &str) -> Self {
        let ticks_path = format!("{}/parquet/bigdata/ticks", base_path);
        let candles_path = format!("{}/parquet/bigdata/candles", base_path);
        let history_path = format!("{}/parquet/history", base_path);
        
        let _ = std::fs::create_dir_all(Path::new(&ticks_path));
        let _ = std::fs::create_dir_all(Path::new(&candles_path));
        let _ = std::fs::create_dir_all(Path::new(&history_path));
        
        info!("[Parquet] BigData directories initialized: ticks={}, candles={}", ticks_path, candles_path);
        Self {
            ticks_path,
            candles_path,
            buffers: Mutex::new(HashMap::new()),
            total_ticks_written: Mutex::new(0),
        }
    }

    /// Buffer live market ticks. Automatically flushes when buffer is full.
    /// This is the HOT PATH — called every SHM tick from main loop.
    pub fn write_unfiltered_ticks(&self, symbol: &str, timestamps: Vec<i64>, prices: Vec<f64>, volumes: Vec<f64>) -> anyhow::Result<()> {
        let n = timestamps.len();
        if n == 0 {
            return Ok(());
        }

        let should_flush;
        {
            let mut buffers = self.buffers.lock().unwrap();
            let buf = buffers.entry(symbol.to_string()).or_default();
            for i in 0..n {
                buf.push(timestamps[i], prices[i], volumes[i]);
            }
            should_flush = buf.len() >= BUFFER_FLUSH_SIZE;
        }

        if should_flush {
            self.flush_symbol(symbol)?;
        }

        Ok(())
    }

    /// Flush a single symbol's buffer to Parquet file.
    fn flush_symbol(&self, symbol: &str) -> anyhow::Result<()> {
        let (timestamps, prices, volumes) = {
            let mut buffers = self.buffers.lock().unwrap();
            match buffers.get_mut(symbol) {
                Some(buf) if buf.len() > 0 => buf.drain(),
                _ => return Ok(()),
            }
        };

        let n = timestamps.len();
        let file_path = format!("{}/{}_bigdata.parquet", self.ticks_path, symbol);

        // Read existing data if file exists
        let mut all_ts: Vec<i64> = Vec::new();
        let mut all_px: Vec<f64> = Vec::new();
        let mut all_vol: Vec<f64> = Vec::new();

        if Path::new(&file_path).exists() {
            match File::open(&file_path) {
                Ok(file) => {
                    match ParquetRecordBatchReaderBuilder::try_new(file) {
                        Ok(builder) => {
                            if let Ok(reader) = builder.build() {
                                for batch_result in reader {
                                    if let Ok(batch) = batch_result {
                                        if let (Some(ts_col), Some(px_col), Some(vol_col)) = (
                                            batch.column(0).as_any().downcast_ref::<Int64Array>(),
                                            batch.column(1).as_any().downcast_ref::<Float64Array>(),
                                            batch.column(2).as_any().downcast_ref::<Float64Array>(),
                                        ) {
                                            all_ts.extend(ts_col.values().iter().copied());
                                            all_px.extend(px_col.values().iter().copied());
                                            all_vol.extend(vol_col.values().iter().copied());
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            // Corrupted file — overwrite
                            warn!("[Parquet] Corrupted tick file for {}, overwriting", symbol);
                        }
                    }
                }
                Err(_) => {}
            }
        }

        // Append new data
        all_ts.extend(timestamps.iter().copied());
        all_px.extend(prices.iter().copied());
        all_vol.extend(volumes.iter().copied());

        // Write merged data with snappy compression
        let schema = Arc::new(Schema::new(vec![
            Field::new("timestamp", DataType::Int64, false),
            Field::new("price", DataType::Float64, false),
            Field::new("volume", DataType::Float64, false),
        ]));

        let ts_array = Arc::new(Int64Array::from(all_ts)) as Arc<dyn arrow::array::Array>;
        let px_array = Arc::new(Float64Array::from(all_px)) as Arc<dyn arrow::array::Array>;
        let vol_array = Arc::new(Float64Array::from(all_vol)) as Arc<dyn arrow::array::Array>;

        let batch = RecordBatch::try_new(schema.clone(), vec![ts_array, px_array, vol_array])?;

        let file = File::create(&file_path)?;
        let props = WriterProperties::builder()
            .set_compression(Compression::SNAPPY)
            .build();
        let mut writer = ArrowWriter::try_new(file, schema, Some(props))?;
        writer.write(&batch)?;
        writer.close()?;

        // Update stats
        {
            let mut total = self.total_ticks_written.lock().unwrap();
            *total += n as u64;
        }

        info!("[Parquet] Flushed {} ticks for {} (total in file: {})", n, symbol, batch.num_rows());
        Ok(())
    }

    /// Flush ALL symbol buffers to disk. Called periodically or on shutdown.
    pub fn flush_all(&self) {
        let symbols: Vec<String> = {
            self.buffers.lock().unwrap().keys().cloned().collect()
        };
        
        let mut flushed = 0;
        for sym in &symbols {
            match self.flush_symbol(sym) {
                Ok(()) => flushed += 1,
                Err(e) => error!("[Parquet] Failed to flush {}: {}", sym, e),
            }
        }
        
        if flushed > 0 {
            let total = *self.total_ticks_written.lock().unwrap();
            info!("[Parquet] Periodic flush: {} symbols, total ticks written: {}", flushed, total);
        }
    }

    /// Get buffer stats for monitoring
    pub fn buffer_stats(&self) -> HashMap<String, usize> {
        self.buffers.lock().unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.len()))
            .collect()
    }

    pub fn total_ticks_written(&self) -> u64 {
        *self.total_ticks_written.lock().unwrap()
    }

    pub fn ticks_path(&self) -> &str {
        &self.ticks_path
    }

    pub fn candles_path(&self) -> &str {
        &self.candles_path
    }
}
