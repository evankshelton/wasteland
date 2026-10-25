extends SceneTree
## Bakes the zombie used in first-person fights from the files in
## res://models/zombie/ (git-ignored, so each developer supplies them):
##
##   mesh/zombie.obj + mesh/zombie_basecolor.jpg   the unrigged model
##   animations/*.fbx                               Mixamo animations exported
##                                                  "without skin" for that model
##
## The FBX files carry the Mixamo skeleton (fitted to this model) but no mesh,
## so this skins the OBJ to that skeleton automatically: each vertex follows
## its nearest bone, blending with that bone's parent or child when it sits
## near a joint. The result, with every animation attached, is saved to
## res://models/zombie/zombie_rigged.scn, which zombie_3d.gd loads.
##
##   godot --headless --path client --import
##   godot --headless --path client -s res://tools/rig_zombie.gd
##
## Re-run it after changing the mesh or adding animations. Animation names are
## the FBX file names in snake case ("Zombie Walk.fbx" -> "zombie_walk").

const DIR := "res://models/zombie/"
const MESH_PATH := DIR + "mesh/zombie.obj"
const TEXTURE_PATH := DIR + "mesh/zombie_basecolor.jpg"
const OUT_PATH := DIR + "zombie_rigged.scn"
const HEIGHT := 1.8 ## metres, head to toe
const FINGERS := ["Thumb", "Index", "Middle", "Ring", "Pinky"]
const LOOPING := ["walk", "idle", "run", "crawl"]
const BLEND_RATIO := 1.6 ## blend with a related bone this much further away


func _init() -> void:
	_bake()


func _bake() -> void:
	var started := Time.get_ticks_msec()
	var fbx_paths := _animation_files()
	if fbx_paths.is_empty():
		return _fail("no .fbx animations in %sanimations/" % DIR)
	if not ResourceLoader.exists(MESH_PATH):
		return _fail("missing %s (unzip zombie.zip into mesh/ and run --import)" % MESH_PATH)

	var source: Node = load(fbx_paths[0]).instantiate()
	var source_skeleton: Skeleton3D = source.find_children("*", "Skeleton3D")[0]
	var mesh: Mesh = load(MESH_PATH)
	var mesh_height := mesh.get_aabb().size.y

	# Mixamo exports in centimetres; bring the skeleton up to the mesh's units.
	var top := 0.0
	for b in source_skeleton.get_bone_count():
		top = maxf(top, source_skeleton.get_bone_global_rest(b).origin.y)
	var factor := mesh_height / top
	var skeleton := Skeleton3D.new()
	skeleton.name = "Skeleton3D"
	for b in source_skeleton.get_bone_count():
		skeleton.add_bone(source_skeleton.get_bone_name(b))
	for b in source_skeleton.get_bone_count():
		skeleton.set_bone_parent(b, source_skeleton.get_bone_parent(b))
		var rest := source_skeleton.get_bone_rest(b)
		rest.origin *= factor
		skeleton.set_bone_rest(b, rest)
	skeleton.reset_bone_poses()

	var segments := _segments(skeleton)
	print("skeleton: %d bones, %d used for skinning, scaled x%.1f" % [skeleton.get_bone_count(), segments.size(), factor])

	var skinned := ArrayMesh.new()
	var material := StandardMaterial3D.new()
	material.albedo_texture = load(TEXTURE_PATH)
	material.roughness = 0.9
	var blended := 0
	var total := 0
	for s in mesh.get_surface_count():
		var arrays := mesh.surface_get_arrays(s)
		var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		var bones := PackedInt32Array()
		var weights := PackedFloat32Array()
		bones.resize(verts.size() * 4)
		weights.resize(verts.size() * 4)
		for i in verts.size():
			var influence := _influence(verts[i], segments, skeleton)
			bones[i * 4] = influence[0]
			weights[i * 4] = influence[1]
			bones[i * 4 + 1] = influence[2]
			weights[i * 4 + 1] = influence[3]
			if influence[3] > 0.0:
				blended += 1
		total += verts.size()
		arrays[Mesh.ARRAY_BONES] = bones
		arrays[Mesh.ARRAY_WEIGHTS] = weights
		skinned.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		skinned.surface_set_material(s, material)
	print("skinned %d vertices (%d%% blended across a joint)" % [total, blended * 100 / maxi(total, 1)])

	var skin := Skin.new()
	for b in skeleton.get_bone_count():
		skin.add_named_bind(skeleton.get_bone_name(b), skeleton.get_bone_global_rest(b).affine_inverse())

	# ZombieModel / Rig (scaled to HEIGHT) / Skeleton3D / Body, plus Rig / AnimationPlayer.
	var root := Node3D.new()
	root.name = "ZombieModel"
	var rig := Node3D.new()
	rig.name = "Rig"
	rig.scale = Vector3.ONE * (HEIGHT / mesh_height)
	root.add_child(rig)
	rig.add_child(skeleton)
	var body := MeshInstance3D.new()
	body.name = "Body"
	body.mesh = skinned
	body.skin = skin
	skeleton.add_child(body)
	body.skeleton = NodePath("..")
	var player := AnimationPlayer.new()
	player.name = "AnimationPlayer"
	rig.add_child(player)
	var library := AnimationLibrary.new()
	for path in fbx_paths:
		var names := _add_animations(path, library, factor)
		print("animations from %s: %s" % [path.get_file(), names])
	player.add_animation_library("", library)
	for n: Node in [rig, skeleton, body, player]:
		n.owner = root

	var packed := PackedScene.new()
	var err := packed.pack(root)
	if err == OK:
		err = ResourceSaver.save(packed, OUT_PATH)
	if err != OK:
		return _fail("could not save %s: %s" % [OUT_PATH, error_string(err)])
	print("saved %s in %.1fs" % [OUT_PATH, (Time.get_ticks_msec() - started) / 1000.0])
	source.free()
	root.free()
	quit(0)


func _animation_files() -> Array[String]:
	var out: Array[String] = []
	var dir := DirAccess.open(DIR + "animations")
	if dir:
		for f in dir.get_files():
			if f.get_extension().to_lower() == "fbx":
				out.append(DIR + "animations/" + f)
	out.sort()
	return out


## Bones a vertex may follow: everything but fingers and the *_End leaf markers.
## Each is a segment from the bone to its first child (or a point for leaves).
func _segments(sk: Skeleton3D) -> Array:
	var out := []
	for b in sk.get_bone_count():
		var bone_name := sk.get_bone_name(b)
		if bone_name.ends_with("_End") or FINGERS.any(func(f: String) -> bool: return f in bone_name):
			continue
		var start := sk.get_bone_global_rest(b).origin
		var children := sk.get_bone_children(b)
		var end := sk.get_bone_global_rest(children[0]).origin if not children.is_empty() else start
		out.append({"bone": b, "a": start, "b": end, "parent": sk.get_bone_parent(b), "children": children})
	return out


## [bone1, weight1, bone2, weight2] for one rest-pose vertex.
func _influence(p: Vector3, segments: Array, sk: Skeleton3D) -> Array:
	var best := -1
	var best_d := INF
	var dists := PackedFloat32Array()
	dists.resize(segments.size())
	for i in segments.size():
		var seg: Dictionary = segments[i]
		var d := p.distance_to(Geometry3D.get_closest_point_to_segment(p, seg.a, seg.b))
		dists[i] = d
		if d < best_d:
			best_d = d
			best = i
	var first: Dictionary = segments[best]
	# Only blend with a bone joined to the nearest one, so limbs never pull on each other.
	var second := -1
	var second_d := INF
	for i in segments.size():
		var other: Dictionary = segments[i]
		var related: bool = other.bone == first.parent or first.children.has(other.bone)
		if related and dists[i] < second_d:
			second_d = dists[i]
			second = i
	if second < 0 or second_d > best_d * BLEND_RATIO + 0.01:
		return [first.bone, 1.0, 0, 0.0]
	var w1 := 1.0 / pow(best_d + 0.005, 2.0)
	var w2 := 1.0 / pow(second_d + 0.005, 2.0)
	return [first.bone, w1 / (w1 + w2), segments[second].bone, w2 / (w1 + w2)]


func _add_animations(path: String, library: AnimationLibrary, factor: float) -> Array[String]:
	var scene: Node = load(path).instantiate()
	var names: Array[String] = []
	for ap: AnimationPlayer in scene.find_children("*", "AnimationPlayer"):
		var source_names := ap.get_animation_list()
		for source_name in source_names:
			var anim: Animation = ap.get_animation(source_name).duplicate(true)
			for t in anim.get_track_count():
				if anim.track_get_type(t) == Animation.TYPE_POSITION_3D:
					for k in anim.track_get_key_count(t):
						anim.track_set_key_value(t, k, anim.track_get_key_value(t, k) * factor)
			var anim_name := path.get_file().get_basename().to_snake_case().replace(" ", "_")
			if source_names.size() > 1:
				anim_name += "_" + source_name.to_snake_case()
			if LOOPING.any(func(w: String) -> bool: return w in anim_name):
				anim.loop_mode = Animation.LOOP_LINEAR
			library.add_animation(anim_name, anim)
			names.append(anim_name)
	scene.free()
	return names


func _fail(why: String) -> void:
	push_error("rig_zombie: " + why)
	quit(1)
