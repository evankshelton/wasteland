class_name Zombie3D
extends CharacterBody3D
## A radioactive zombie in the first-person arena: shambles at the player and
## claws when close. Built from primitives in the overworld sprite's colours.

signal died(zombie: Zombie3D)
signal attacked(damage: float)

const ATTACK_RANGE := 1.6
const ATTACK_DAMAGE := 12.0
const ATTACK_INTERVAL := 1.1
const MAX_HEALTH := 100.0

const SKIN := Color(0.33, 1.0, 0.33)
const RAGS := Color(0.55, 0.1, 0.55)
const PANTS := Color(0.2, 0.2, 0.22)
const EYES := Color(1.0, 0.2, 0.15)

var monster_id := 0
var health := MAX_HEALTH
var target: Node3D

var _speed := 1.5
var _attack_cooldown := 0.8
var _phase := 0.0
var _flash := 0.0
var _dead := false
var _rig: Node3D
var _arms: Array[Node3D] = []
var _skin_material: StandardMaterial3D


func _ready() -> void:
	collision_layer = 4 # enemies
	# World and each other, but not the player: a zombie walking into the
	# player's capsule would push it up and carry the player off on its head.
	# Zombies stop at claw range instead; the player still can't walk through them.
	collision_mask = 1 | 4
	_speed = randf_range(1.2, 1.8)
	_phase = randf() * TAU
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.35
	capsule.height = 1.8
	shape.shape = capsule
	shape.position.y = 0.9
	add_child(shape)
	_build_body()


func _build_body() -> void:
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
	if _dead or target == null:
		return
	_phase += delta * 4.0
	var to := target.global_position - global_position
	to.y = 0.0
	var dist := to.length()
	if dist > 0.01:
		rotation.y = atan2(to.x, to.z)
	if dist > ATTACK_RANGE * 0.8:
		var forward := to / dist
		var side := Vector3(forward.z, 0, -forward.x)
		velocity = (forward + side * sin(_phase * 0.5) * 0.35).normalized() * _speed
	else:
		velocity = Vector3.ZERO
	move_and_slide()

	_attack_cooldown -= delta
	if dist <= ATTACK_RANGE and _attack_cooldown <= 0.0:
		_attack_cooldown = ATTACK_INTERVAL
		attacked.emit(ATTACK_DAMAGE)
		for arm in _arms:
			arm.rotation.x = -0.6 # Swipe; eases back below.

	# Shamble: sway the body, swing the arms out of step.
	_rig.rotation.z = sin(_phase) * 0.08
	_rig.position.y = absf(sin(_phase)) * 0.05
	for i in _arms.size():
		_arms[i].rotation.x = lerpf(_arms[i].rotation.x, sin(_phase + i * PI) * 0.15, delta * 6.0)
	if _flash > 0.0:
		_flash = maxf(0.0, _flash - delta * 6.0)
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
	tween.tween_property(_rig, ^"rotation:x", -PI / 2.0, 0.45).set_trans(Tween.TRANS_BOUNCE).set_ease(Tween.EASE_OUT)
	tween.tween_interval(2.5)
	tween.tween_property(_rig, ^"position:y", -0.5, 1.0)
	died.emit(self)
