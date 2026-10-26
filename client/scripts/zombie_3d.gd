class_name Zombie3D
extends CharacterBody3D
## A radioactive zombie in the first-person arena: shambles at the player and
## claws when close.
##
## Uses the rigged, animated model baked by tools/rig_zombie.gd when it exists
## (res://models/zombie/zombie_rigged.scn, git-ignored). Animations are found
## by name: one containing "walk" loops while it shambles; ones containing
## "attack"/"punch"/"bite" and "death"/"dying" are used if present, otherwise
## the claw is a lunge and the death a topple. Without the model it falls back
## to a block figure in the overworld sprite's colours.

signal died(zombie: Zombie3D)
signal attacked(damage: float)

const MODEL_PATH := "res://models/zombie/zombie_rigged.scn"
const ATTACK_RANGE := 1.6
const ATTACK_DAMAGE := 3.0 ## against 6-12 starting hit points
const ATTACK_INTERVAL := 1.1
const MAX_HEALTH := 100.0
const GRAVITY := 20.0
## Ground speed (m/s) the walk animation matches at 1x. The bake measures the
## real value and stores it on the model; this is the fallback.
const DEFAULT_WALK_ANIM_SPEED := 0.3

const SKIN := Color(0.33, 1.0, 0.33)
const RAGS := Color(0.55, 0.1, 0.55)
const PANTS := Color(0.2, 0.2, 0.22)
const EYES := Color(1.0, 0.2, 0.15)

static var _model: PackedScene
static var _model_checked := false
static var _flash_material: StandardMaterial3D

var monster_id := 0
var health := MAX_HEALTH
var target: Node3D

var _speed := 0.9
var _walk_anim_speed := DEFAULT_WALK_ANIM_SPEED
var _sway := 0.35 ## sideways zigzag, as a fraction of forward speed
var _attack_cooldown := 0.8
var _phase := 0.0
var _flash := 0.0
var _dead := false
var _rig: Node3D
# Block figure only:
var _arms: Array[Node3D] = []
var _skin_material: StandardMaterial3D
# Rigged model only:
var _anim: AnimationPlayer
var _body: MeshInstance3D
var _walk := &""
var _attack := &""
var _death := &""


func _ready() -> void:
	collision_layer = 4 # enemies
	# World and each other, but not the player: a zombie walking into the
	# player's capsule would push it up and carry the player off on its head.
	# Zombies stop at claw range instead; the player still can't walk through them.
	collision_mask = 1 | 4
	# Slow and relentless (the player runs at 5 m/s); the walk animation is
	# sped up to match so the feet keep pace with the ground.
	_speed = randf_range(0.7, 1.0)
	_phase = randf() * TAU
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.35
	capsule.height = 1.8
	shape.shape = capsule
	shape.position.y = 0.9
	add_child(shape)
	if _load_model():
		_build_model()
	else:
		_build_blocks()


static func _load_model() -> bool:
	if not _model_checked:
		_model_checked = true
		if ResourceLoader.exists(MODEL_PATH):
			_model = load(MODEL_PATH)
		_flash_material = StandardMaterial3D.new()
		_flash_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		_flash_material.albedo_color = Color(0.8, 1.0, 0.7, 0.6)
		_flash_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return _model != null


func _build_model() -> void:
	_rig = _model.instantiate()
	add_child(_rig)
	_walk_anim_speed = _rig.get_meta(&"walk_speed", DEFAULT_WALK_ANIM_SPEED)
	_sway = 0.0 # The walk animation sways on its own; sideways drift would make the feet skate.
	_body = _rig.find_children("*", "MeshInstance3D")[0]
	_anim = _rig.find_children("*", "AnimationPlayer")[0]
	for anim_name in _anim.get_animation_list():
		var n := anim_name.to_lower()
		if _walk.is_empty() and "walk" in n:
			_walk = anim_name
		elif _attack.is_empty() and ("attack" in n or "punch" in n or "bite" in n):
			_attack = anim_name
		elif _death.is_empty() and ("death" in n or "dying" in n):
			_death = anim_name
	if _walk.is_empty() and not _anim.get_animation_list().is_empty():
		_walk = _anim.get_animation_list()[0]
	if not _walk.is_empty():
		_anim.play(_walk)
		# Out of step with each other, and stride matched to this zombie's pace.
		_anim.seek(randf() * _anim.get_animation(_walk).length, true)
		_anim.speed_scale = _speed / _walk_anim_speed
	# Step the animation with the body's movement (physics ticks), not render
	# frames, so planted feet stay put between ticks.
	_anim.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_PHYSICS
	_anim.animation_finished.connect(_on_animation_finished)
	# Radioactive: a faint green glow around each one.
	var glow := OmniLight3D.new()
	glow.light_color = Color(0.4, 1.0, 0.3)
	glow.light_energy = 0.3
	glow.omni_range = 2.0
	glow.position = Vector3(0, 1.2, -0.4)
	_rig.add_child(glow)


func _build_blocks() -> void:
	_rig = Node3D.new()
	add_child(_rig)
	_skin_material = _material(SKIN, 0.6)
	var rags := _material(RAGS)
	var pants := _material(PANTS)
	_box(Vector3(0.18, 0.8, 0.2), Vector3(-0.13, 0.4, 0), pants)
	_box(Vector3(0.18, 0.8, 0.2), Vector3(0.13, 0.4, 0), pants)
	_box(Vector3(0.5, 0.65, 0.28), Vector3(0, 1.12, 0), rags)
	_box(Vector3(0.32, 0.32, 0.32), Vector3(0, 1.62, 0.02), _skin_material)
	_box(Vector3(0.07, 0.05, 0.02), Vector3(-0.08, 1.66, 0.18), _material(EYES, 3.0))
	_box(Vector3(0.07, 0.05, 0.02), Vector3(0.08, 1.66, 0.18), _material(EYES, 3.0))
	# Arms reach forward (+z, which faces the player).
	for side in [-1.0, 1.0]:
		var shoulder := Node3D.new()
		shoulder.position = Vector3(0.32 * side, 1.38, 0)
		_rig.add_child(shoulder)
		var arm := MeshInstance3D.new()
		var mesh := BoxMesh.new()
		mesh.size = Vector3(0.13, 0.13, 0.65)
		arm.mesh = mesh
		arm.material_override = _skin_material
		arm.position = Vector3(0, 0, 0.3)
		shoulder.add_child(arm)
		_arms.append(shoulder)


func _box(size: Vector3, pos: Vector3, material: Material) -> void:
	var mi := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	_rig.add_child(mi)


func _material(color: Color, glow := 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness = 0.9
	if glow > 0.0:
		m.emission_enabled = true
		m.emission = color
		m.emission_energy_multiplier = glow
	return m


func _physics_process(delta: float) -> void:
	_update_flash(delta)
	if _dead or target == null:
		return
	_phase += delta * 4.0
	var to := target.global_position - global_position
	to.y = 0.0
	var dist := to.length()
	if dist > 0.01:
		rotation.y = atan2(to.x, to.z)
	var walking := dist > ATTACK_RANGE * 0.8
	var fall := 0.0 if is_on_floor() else velocity.y - GRAVITY * delta # Follow the ground's slopes.
	if walking:
		var forward := to / dist
		var side := Vector3(forward.z, 0, -forward.x)
		velocity = (forward + side * sin(_phase * 0.5) * _sway).normalized() * _speed
	else:
		velocity = Vector3.ZERO
	velocity.y = fall
	move_and_slide()

	_attack_cooldown -= delta
	if dist <= ATTACK_RANGE and _attack_cooldown <= 0.0:
		_attack_cooldown = ATTACK_INTERVAL
		attacked.emit(ATTACK_DAMAGE)
		_play_attack()

	if _anim:
		# Full stride while closing in, a slow shuffle in place while clawing.
		if _anim.current_animation == _walk:
			_anim.speed_scale = (_speed if walking else _walk_anim_speed * 1.2) / _walk_anim_speed
	else:
		# Block figure: sway the body, swing the arms out of step.
		_rig.rotation.z = sin(_phase) * 0.08
		_rig.position.y = absf(sin(_phase)) * 0.05
		for i in _arms.size():
			_arms[i].rotation.x = lerpf(_arms[i].rotation.x, sin(_phase + i * PI) * 0.15, delta * 6.0)


func _play_attack() -> void:
	if _anim and not _attack.is_empty():
		_anim.speed_scale = 1.0
		_anim.play(_attack)
	elif _anim:
		# No attack animation: lunge at the player and back.
		var tween := create_tween()
		tween.tween_property(_rig, ^"position:z", 0.35, 0.12).set_ease(Tween.EASE_OUT)
		tween.tween_property(_rig, ^"position:z", 0.0, 0.3)
	else:
		for arm in _arms:
			arm.rotation.x = -0.6 # Swipe; eases back in _physics_process.


func _on_animation_finished(anim_name: StringName) -> void:
	if anim_name == _attack and not _dead and not _walk.is_empty():
		_anim.play(_walk)


func _update_flash(delta: float) -> void:
	if _flash <= 0.0:
		return
	_flash = maxf(0.0, _flash - delta * 6.0)
	if _body:
		_body.material_overlay = _flash_material if _flash > 0.0 else null
	else:
		_skin_material.emission_energy_multiplier = 0.6 + _flash * 6.0


func hit(damage: float) -> void:
	if _dead:
		return
	health -= damage
	_flash = 1.0
	if health <= 0.0:
		_die()


func is_dead() -> bool:
	return _dead


func _die() -> void:
	_dead = true
	velocity = Vector3.ZERO
	collision_layer = 0
	collision_mask = 0
	var tween := create_tween()
	if _anim and not _death.is_empty():
		_anim.speed_scale = 1.0
		_anim.play(_death)
		tween.tween_interval(_anim.get_animation(_death).length + 2.0)
	else:
		if _anim:
			_anim.pause()
		tween.tween_property(_rig, ^"rotation:x", -PI / 2.0, 0.45).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
		tween.tween_interval(2.5)
	tween.tween_property(_rig, ^"position:y", -0.5, 1.0)
	died.emit(self)
