package syncstore

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed admin/*
var adminAssets embed.FS

func adminFiles() http.Handler {
	assets, _ := fs.Sub(adminAssets, "admin")
	return http.StripPrefix("/admin/", http.FileServer(http.FS(assets)))
}
