package config

import (
	"log"
	"os"
	"path/filepath"
)

type StorageConfig struct {
	BasePath     string
	BigDataPath  string
	HistoryPath  string
	TrainingPath string
}

func InitStorage() StorageConfig {
	// Custom path from user
	basePath := "/mnt/d/database"
	
	cfg := StorageConfig{
		BasePath:     basePath,
		BigDataPath:  filepath.Join(basePath, "bigdata_unfiltered"),
		HistoryPath:  filepath.Join(basePath, "history_orc"),
		TrainingPath: filepath.Join(basePath, "training_agents"),
	}

	dirs := []string{cfg.BasePath, cfg.BigDataPath, cfg.HistoryPath, cfg.TrainingPath}

	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			log.Printf("Warning: Could not create DB dir %s: %v", d, err)
		} else {
			log.Printf("Storage ready at %s", d)
		}
	}

	return cfg
}
