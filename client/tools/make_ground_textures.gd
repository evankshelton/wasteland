extends SceneTree
## Generates the realistic ground textures for the first-person arena (the
## overworld keeps its pixel art). Each is a seamless 512x512 colour map plus a
## normal map built from the same height field, written to
## res://assets/ground/<name>_albedo.jpg and <name>_normal.jpg.
##
##   godot --headless --path client -s res://tools/make_ground_textures.gd
##   godot --headless --path client --import
##
## Recipes layer smooth seamless noise (FastNoiseLite.get_seamless_image) with
## tiling cellular noise (_worley, written here because cross-fading cellular
## noise to make it seamless smears it) for cracks, stones and leaves, and mix
## them into colour and height. Which terrain uses which texture is GROUND_FOR
## in encounter.gd.

const SIZE := 512
const OUT_DIR := "res://assets/ground/"

## Name -> normal map strength.
const TEXTURES := {
	"dirt": 5.0, "scrub": 4.0, "forest": 5.0, "gravel": 9.0, "asphalt": 4.0, "rock": 8.0,
	"ash": 4.0, "char": 5.0, "irradiated": 5.0, "mud": 3.0, "concrete": 3.0,
}

var _seed := 1


func _init() -> void:
	_run.call_deferred()


func _run() -> void:
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(OUT_DIR))
	var started := Time.get_ticks_msec()
	for name: String in TEXTURES:
		var t := Time.get_ticks_msec()
		var layer: Array = call("_" + name) # [colour: PackedColorArray, height: PackedFloat32Array]
		_save(name, layer[0], layer[1], TEXTURES[name])
		print("%-11s %d ms" % [name, Time.get_ticks_msec() - t])
	print("wrote %d ground textures to %s in %.1fs" % [TEXTURES.size(), OUT_DIR, (Time.get_ticks_msec() - started) / 1000.0])
	quit()


# ---- noise ----

## Seamless noise, 0..1 per pixel. `features` is roughly how many blobs across the texture.
func _noise(features: float, octaves := 4, type := FastNoiseLite.TYPE_SIMPLEX_SMOOTH) -> PackedFloat32Array:
	var n := FastNoiseLite.new()
	_seed += 1
	n.seed = _seed
	n.noise_type = type
	n.frequency = features / SIZE
	n.fractal_octaves = octaves
	if octaves <= 1:
		n.fractal_type = FastNoiseLite.FRACTAL_NONE
	return _to_floats(n)


## Tiling cellular (Worley) noise: `cells` random points per side on a grid
## that wraps, so it tiles exactly. Returns {f1: distance to the nearest point,
## edge: distance to the cell border (F2 - F1), value: a random 0..1 per cell},
## distances scaled to 0..1, all from the same layout.
func _worley(cells: int, jitter := 0.9) -> Dictionary:
	var rng := RandomNumberGenerator.new()
	_seed += 1
	rng.seed = _seed
	var points := PackedVector2Array()
	var values := PackedFloat32Array()
	for i in cells * cells:
		points.append(Vector2(0.5, 0.5) + Vector2(rng.randf() - 0.5, rng.randf() - 0.5) * jitter)
		values.append(rng.randf())
	var f1 := PackedFloat32Array()
	var edge := PackedFloat32Array()
	var value := PackedFloat32Array()
	f1.resize(SIZE * SIZE)
	edge.resize(SIZE * SIZE)
	value.resize(SIZE * SIZE)
	var scale := float(cells) / SIZE
	for y in SIZE:
		for x in SIZE:
			var px := (x + 0.5) * scale
			var py := (y + 0.5) * scale
			var cx := int(px)
			var cy := int(py)
			var d1 := 9.0
			var d2 := 9.0
			var v := 0.0
			for oy in range(-1, 2):
				for ox in range(-1, 2):
					var gx := cx + ox
					var gy := cy + oy
					var k := posmod(gy, cells) * cells + posmod(gx, cells)
					var q := Vector2(gx, gy) + points[k]
					var d := Vector2(px, py).distance_to(q)
					if d < d1:
						d2 = d1
						d1 = d
						v = values[k]
					elif d < d2:
						d2 = d
			var i := y * SIZE + x
			f1[i] = d1
			edge[i] = d2 - d1
			value[i] = v
	return {"f1": _normalised(f1), "edge": _normalised(edge), "value": value}


func _normalised(a: PackedFloat32Array) -> PackedFloat32Array:
	var top := 0.0
	for v in a:
		top = maxf(top, v)
	for i in a.size():
		a[i] /= top
	return a


func _to_floats(n: FastNoiseLite) -> PackedFloat32Array:
	var img := n.get_seamless_image(SIZE, SIZE, false, false, 0.1, true)
	img.convert(Image.FORMAT_L8)
	var bytes := img.get_data()
	var out := PackedFloat32Array()
	out.resize(SIZE * SIZE)
	for i in out.size():
		out[i] = bytes[i] / 255.0
	return out


## Thin dark lines along some cell borders, 1 on a crack. `coverage` (0..1)
## is how much of the network actually cracks; the rest stays whole, so cracks
## run as irregular fissures instead of a tiled mosaic.
func _cracks(cells: int, width: float, coverage := 0.5) -> PackedFloat32Array:
	var edge: PackedFloat32Array = _worley(cells).edge
	var mask := _noise(4, 3)
	var out := PackedFloat32Array()
	out.resize(edge.size())
	for i in edge.size():
		var show := smoothstep(1.0 - coverage - 0.08, 1.0 - coverage + 0.08, mask[i])
		out[i] = (1.0 - smoothstep(0.0, width, edge[i])) * show
	return out


func _blank() -> Array:
	var colour := PackedColorArray()
	colour.resize(SIZE * SIZE)
	var height := PackedFloat32Array()
	height.resize(SIZE * SIZE)
	return [colour, height]


# ---- recipes: each returns [colour, height] ----

## Cracked, dry, pebbly earth: the default wasteland.
func _dirt() -> Array:
	var out := _blank()
	var broad := _noise(5)
	var grain := _noise(120, 2)
	var cracks := _cracks(12, 0.05, 0.45)
	var pebbles := _worley(64)
	var stones: PackedFloat32Array = pebbles.f1
	var tint: PackedFloat32Array = pebbles.value
	for i in SIZE * SIZE:
		var c := Color(0.5, 0.4, 0.29).lerp(Color(0.37, 0.29, 0.21), broad[i])
		c = c * (0.86 + 0.28 * grain[i])
		var h := 0.35 * broad[i] + 0.25 * grain[i]
		var pebble := 1.0 - smoothstep(0.12, 0.22, stones[i])
		if pebble > 0.0 and tint[i] > 0.6:
			c = c.lerp(Color(0.58, 0.54, 0.48) * (0.8 + 0.4 * grain[i]), pebble)
			h += 0.5 * pebble
		c = c.lerp(Color(0.2, 0.15, 0.1), cracks[i] * 0.75)
		h -= 0.6 * cracks[i]
		out[0][i] = c
		out[1][i] = h
	return out


## Dry earth with clumps of dead, straw-coloured grass.
func _scrub() -> Array:
	var out := _blank()
	var broad := _noise(5)
	var patches := _noise(22, 3)
	var blades := _noise(260, 1)
	var blades2 := _noise(180, 2)
	var grain := _noise(120, 2)
	for i in SIZE * SIZE:
		var c := Color(0.46, 0.37, 0.26).lerp(Color(0.36, 0.28, 0.2), broad[i]) * (0.88 + 0.24 * grain[i])
		var grass := smoothstep(0.42, 0.6, patches[i]) * smoothstep(0.35, 0.65, blades[i] * 0.6 + blades2[i] * 0.4)
		var straw := Color(0.62, 0.55, 0.3).lerp(Color(0.42, 0.42, 0.2), blades2[i]) * (0.75 + 0.5 * blades[i])
		out[0][i] = c.lerp(straw, grass)
		out[1][i] = 0.3 * broad[i] + 0.2 * grain[i] + 0.6 * grass
	return out


## Dark loam under the dead trees, with dry leaf litter and twigs.
func _forest() -> Array:
	var out := _blank()
	var broad := _noise(6)
	var grain := _noise(140, 2)
	var litter := _worley(80)
	var leaves: PackedFloat32Array = litter.f1
	var leaf_tone: PackedFloat32Array = litter.value
	var twigs := _noise(30, 3)
	for i in SIZE * SIZE:
		var c := Color(0.28, 0.2, 0.14).lerp(Color(0.2, 0.15, 0.11), broad[i]) * (0.85 + 0.3 * grain[i])
		var h := 0.3 * broad[i] + 0.2 * grain[i]
		var leaf := (1.0 - smoothstep(0.3, 0.45, leaves[i])) * (1.0 if leaf_tone[i] > 0.25 else 0.0)
		c = c.lerp(Color(0.55, 0.36, 0.18).lerp(Color(0.38, 0.28, 0.17), leaf_tone[i]), leaf * 0.9)
		h += 0.3 * leaf
		var twig := 1.0 - smoothstep(0.0, 0.012, absf(twigs[i] - 0.5))
		c = c.lerp(Color(0.36, 0.27, 0.18), twig * 0.9)
		h += 0.4 * twig
		out[0][i] = c
		out[1][i] = h
	return out


## Loose broken stone and concrete chunks.
func _gravel() -> Array:
	var out := _blank()
	var stones := _worley(40)
	var dist: PackedFloat32Array = stones.f1
	var edge: PackedFloat32Array = stones.edge
	var tone: PackedFloat32Array = stones.value
	var grain := _noise(200, 2)
	var dust := _noise(6)
	for i in SIZE * SIZE:
		var stone := smoothstep(0.03, 0.14, edge[i])
		var c := Color(0.52, 0.5, 0.47).lerp(Color(0.38, 0.35, 0.32), tone[i])
		c = c.lerp(Color(0.6, 0.55, 0.47), smoothstep(0.7, 1.0, tone[i]) * 0.5) * (0.85 + 0.3 * grain[i])
		c = Color(0.17, 0.15, 0.13).lerp(c, stone)
		c = c.lerp(Color(0.45, 0.38, 0.3), dust[i] * 0.3)
		out[0][i] = c
		out[1][i] = stone * (1.0 - dist[i] * 0.8) + 0.15 * grain[i]
	return out


## Old, sun-faded, cracked asphalt.
func _asphalt() -> Array:
	var out := _blank()
	var grain := _noise(260, 1)
	var aggregate: PackedFloat32Array = _worley(128).f1
	var wear := _noise(4)
	var cracks := _cracks(6, 0.035, 0.3)
	var stain := _noise(9, 3)
	for i in SIZE * SIZE:
		var c := Color(0.23, 0.23, 0.24).lerp(Color(0.32, 0.31, 0.3), wear[i]) * (0.85 + 0.3 * grain[i])
		var chip := 1.0 - smoothstep(0.1, 0.2, aggregate[i])
		c = c.lerp(Color(0.48, 0.46, 0.43), chip * 0.6)
		c = c.lerp(Color(0.12, 0.12, 0.12), smoothstep(0.55, 0.8, stain[i]) * 0.4)
		c = c.lerp(Color(0.08, 0.08, 0.08), cracks[i])
		out[0][i] = c
		out[1][i] = 0.2 * grain[i] + 0.2 * chip - 0.8 * cracks[i]
	return out


## Weathered, layered rock for hills and mountains.
func _rock() -> Array:
	var out := _blank()
	var broad := _noise(4, 5)
	var ridges := _noise(10, 4, FastNoiseLite.TYPE_PERLIN)
	var grain := _noise(150, 2)
	var cracks := _cracks(8, 0.045, 0.4)
	var lichen := _noise(20, 3)
	for i in SIZE * SIZE:
		var y := float(i / SIZE) / SIZE
		var strata := 0.5 + 0.5 * sin(TAU * (6.0 * y + 1.8 * broad[i]))
		var c := Color(0.5, 0.45, 0.4).lerp(Color(0.36, 0.33, 0.3), strata * 0.6 + ridges[i] * 0.4) * (0.85 + 0.3 * grain[i])
		c = c.lerp(Color(0.45, 0.43, 0.3), smoothstep(0.65, 0.8, lichen[i]) * 0.5)
		c = c.lerp(Color(0.15, 0.13, 0.12), cracks[i] * 0.8)
		out[0][i] = c
		out[1][i] = 0.5 * ridges[i] + 0.3 * strata + 0.2 * grain[i] - 0.7 * cracks[i]
	return out


## Pale grey ash drifted into ripples.
func _ash() -> Array:
	var out := _blank()
	var warp := _noise(4, 3)
	var grain := _noise(220, 2)
	var tone := _noise(7, 3)
	for i in SIZE * SIZE:
		var x := float(i % SIZE) / SIZE
		var y := float(i / SIZE) / SIZE
		var ripple := 0.5 + 0.5 * sin(TAU * (18.0 * y + 3.0 * x) + 7.0 * warp[i])
		var c := Color(0.6, 0.57, 0.52).lerp(Color(0.45, 0.42, 0.38), tone[i]) * (0.9 + 0.2 * grain[i])
		c = c * (0.9 + 0.12 * ripple)
		out[0][i] = c
		out[1][i] = 0.6 * ripple + 0.2 * grain[i] + 0.2 * tone[i]
	return out


## Scorched, blackened ground in blast craters.
func _char() -> Array:
	var out := _blank()
	var broad := _noise(5)
	var grain := _noise(160, 2)
	var cracks := _cracks(16, 0.06, 0.5)
	var cinders: PackedFloat32Array = _worley(96).f1
	for i in SIZE * SIZE:
		var c := Color(0.16, 0.13, 0.11).lerp(Color(0.28, 0.24, 0.2), broad[i]) * (0.8 + 0.4 * grain[i])
		var cinder := 1.0 - smoothstep(0.1, 0.2, cinders[i])
		c = c.lerp(Color(0.36, 0.33, 0.3), cinder * 0.5)
		c = c.lerp(Color(0.05, 0.04, 0.04), cracks[i])
		out[0][i] = c
		out[1][i] = 0.4 * broad[i] + 0.2 * grain[i] + 0.3 * cinder - 0.6 * cracks[i]
	return out


## Sickly, crusted soil where the radiation is worst.
func _irradiated() -> Array:
	var out := _blank()
	var broad := _noise(5)
	var grain := _noise(140, 2)
	var crust: PackedFloat32Array = _cracks(24, 0.06, 0.55)
	var crystals: PackedFloat32Array = _worley(128).f1
	var blotch := _noise(12, 3)
	for i in SIZE * SIZE:
		var c := Color(0.42, 0.42, 0.24).lerp(Color(0.3, 0.32, 0.18), broad[i]) * (0.85 + 0.3 * grain[i])
		c = c.lerp(Color(0.55, 0.6, 0.25), smoothstep(0.6, 0.8, blotch[i]) * 0.6)
		var plate := 1.0 - crust[i]
		c = Color(0.18, 0.2, 0.1).lerp(c, plate)
		var crystal := 1.0 - smoothstep(0.06, 0.12, crystals[i])
		c = c.lerp(Color(0.7, 0.85, 0.35), crystal)
		out[0][i] = c
		out[1][i] = 0.4 * plate + 0.2 * grain[i] + 0.3 * crystal + 0.2 * broad[i]
	return out


## Wet, dark mud with standing puddles (sludge marsh, lake beds).
func _mud() -> Array:
	var out := _blank()
	var broad := _noise(5, 4)
	var grain := _noise(100, 2)
	var puddles := _noise(8, 3)
	var scum := _noise(40, 2)
	for i in SIZE * SIZE:
		var c := Color(0.27, 0.23, 0.16).lerp(Color(0.18, 0.16, 0.11), broad[i]) * (0.88 + 0.24 * grain[i])
		var wet := smoothstep(0.55, 0.65, puddles[i])
		c = c.lerp(Color(0.1, 0.11, 0.07), wet * 0.8)
		c = c.lerp(Color(0.28, 0.32, 0.14), smoothstep(0.6, 0.8, scum[i]) * (1.0 - wet) * 0.5)
		out[0][i] = c
		out[1][i] = 0.5 * broad[i] + 0.2 * grain[i] - 0.4 * wet
	return out


## Stained, cracked concrete slabs (ruins and the base).
func _concrete() -> Array:
	var out := _blank()
	var grain := _noise(240, 1)
	var stains := _noise(6, 4)
	var rust := _noise(14, 3)
	var cracks := _cracks(5, 0.03, 0.35)
	for i in SIZE * SIZE:
		var x := i % SIZE
		var y := i / SIZE
		var seam := 1.0 if (x % (SIZE / 2) < 3 or y % (SIZE / 2) < 3) else 0.0
		var c := Color(0.6, 0.58, 0.55).lerp(Color(0.45, 0.43, 0.4), stains[i]) * (0.88 + 0.24 * grain[i])
		c = c.lerp(Color(0.45, 0.32, 0.22), smoothstep(0.7, 0.85, rust[i]) * 0.5)
		c = c.lerp(Color(0.25, 0.24, 0.22), max(seam, cracks[i]) * 0.8)
		out[0][i] = c
		out[1][i] = 0.15 * grain[i] + 0.1 * stains[i] - 0.6 * max(seam, cracks[i])
	return out


# ---- output ----

func _save(name: String, colour: PackedColorArray, height: PackedFloat32Array, strength: float) -> void:
	var albedo := PackedByteArray()
	albedo.resize(SIZE * SIZE * 3)
	var normal := PackedByteArray()
	normal.resize(SIZE * SIZE * 3)
	for y in SIZE:
		for x in SIZE:
			var i := y * SIZE + x
			var c := colour[i]
			albedo[i * 3] = clampi(int(c.r * 255.0), 0, 255)
			albedo[i * 3 + 1] = clampi(int(c.g * 255.0), 0, 255)
			albedo[i * 3 + 2] = clampi(int(c.b * 255.0), 0, 255)
			# Slope of the height field (wrapping, so it tiles), OpenGL-style (green up).
			var dx := height[y * SIZE + (x + 1) % SIZE] - height[y * SIZE + (x - 1 + SIZE) % SIZE]
			var dy := height[((y - 1 + SIZE) % SIZE) * SIZE + x] - height[((y + 1) % SIZE) * SIZE + x]
			var n := Vector3(-dx * strength, -dy * strength, 1.0).normalized()
			normal[i * 3] = int((n.x * 0.5 + 0.5) * 255.0)
			normal[i * 3 + 1] = int((n.y * 0.5 + 0.5) * 255.0)
			normal[i * 3 + 2] = int((n.z * 0.5 + 0.5) * 255.0)
	Image.create_from_data(SIZE, SIZE, false, Image.FORMAT_RGB8, albedo).save_jpg(OUT_DIR + name + "_albedo.jpg", 0.9)
	Image.create_from_data(SIZE, SIZE, false, Image.FORMAT_RGB8, normal).save_jpg(OUT_DIR + name + "_normal.jpg", 0.92)
