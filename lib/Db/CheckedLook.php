<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

/**
 * The name, icon and colour of a collection or template, kept to what the columns hold
 * and what the page can show, whichever way they come in (API, template, restore): a long
 * icon or name was a database error (a 500), and any text went into the page's style as
 * a colour (review P16). A collection's icon column is 16 long, and a template's icon
 * becomes one, so both keep to 16.
 */
trait CheckedLook {
	/** @param mixed $name */
	public function setName($name): void {
		$this->setter('name', [mb_substr((string)$name, 0, 255)]);
	}

	/** @param mixed $icon A longer icon is not cut: half an emoji is worse than the default. */
	public function setIcon($icon): void {
		$icon = (string)$icon;
		$this->setter('icon', [($icon === '' || mb_strlen($icon) > 16) ? '📁' : $icon]);
	}

	/** @param mixed $color */
	public function setColor($color): void {
		$color = (string)$color;
		$this->setter('color', [preg_match('/^#[0-9a-fA-F]{3,8}$/', $color) ? $color : '#3b82f6']);
	}
}
