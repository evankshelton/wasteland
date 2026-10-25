extends Node
## Persists the last-used connection details and the per-server character
## tokens that let a player reclaim their character on reconnect.

const PATH := "user://settings.cfg"

var _cfg := ConfigFile.new()


func _ready() -> void:
	_cfg.load(PATH) # A missing file just means first run.


func last(key: String, default: Variant) -> Variant:
	return _cfg.get_value("last", key, default)


func save_last(host: String, port: int, player_name: String) -> void:
	_cfg.set_value("last", "host", host)
	_cfg.set_value("last", "port", port)
	_cfg.set_value("last", "name", player_name)
	_cfg.save(PATH)


func token_for(host: String, port: int, player_name: String) -> String:
	return _cfg.get_value("tokens", _token_key(host, port, player_name), "")


func save_token(host: String, port: int, player_name: String, token: String) -> void:
	_cfg.set_value("tokens", _token_key(host, port, player_name), token)
	_cfg.save(PATH)


func _token_key(host: String, port: int, player_name: String) -> String:
	# Hashed so arbitrary host/name characters can't break the config syntax.
	return ("%s:%d/%s" % [host.to_lower(), port, player_name.to_lower()]).md5_text()
