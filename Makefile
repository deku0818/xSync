PREVIEW_PORT ?= 8870

.PHONY: help preview

help:
	@echo "make preview                     在本机预览设计文档"
	@echo "make preview PREVIEW_PORT=8871   指定预览端口"

preview:
	python3 -m http.server $(PREVIEW_PORT) --bind 127.0.0.1 --directory design
