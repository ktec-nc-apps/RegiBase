<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method int getCollectionId()
 * @method void setCollectionId(int $v)
 * @method string getFieldKey()
 * @method void setFieldKey(string $v)
 * @method string getLabel()
 * @method void setLabel(string $v)
 * @method string getType()
 * @method void setType(string $v)
 * @method ?string getOptions()
 * @method void setOptions(?string $v)
 * @method bool getRequired()
 * @method void setRequired(bool $v)
 * @method bool getSecret()
 * @method void setSecret(bool $v)
 * @method bool getIsTitle()
 * @method void setIsTitle(bool $v)
 * @method bool getListShow()
 * @method void setListShow(bool $v)
 * @method bool getTableShow()
 * @method void setTableShow(bool $v)
 * @method bool getCardShow()
 * @method void setCardShow(bool $v)
 * @method ?string getPlaceholder()
 * @method void setPlaceholder(?string $v)
 * @method int getSort()
 * @method void setSort(int $v)
 * @method int getConcat()
 * @method void setConcat(int $v)
 * @method string getConcatSep()
 * @method void setConcatSep(string $v)
 * @method ?string getConcatSepChar()
 * @method void setConcatSepChar(?string $v)
 */
class FieldEntity extends Entity implements \JsonSerializable {
	protected $collectionId = 0;
	protected $fieldKey = '';
	protected $label = '';
	protected $type = 'text';
	protected $options = null;
	protected $required = false;
	protected $secret = false;
	protected $isTitle = false;
	protected $listShow = true;
	protected $tableShow = true;
	protected $cardShow = true;
	protected $placeholder = null;
	protected $sort = 0;
	protected $concat = 0;
	protected $concatSep = 'space';
	protected $concatSepChar = '';

	public function __construct() {
		$this->addType('collectionId', 'integer');
		$this->addType('required', 'boolean');
		$this->addType('secret', 'boolean');
		$this->addType('isTitle', 'boolean');
		$this->addType('listShow', 'boolean');
		$this->addType('tableShow', 'boolean');
		$this->addType('cardShow', 'boolean');
		$this->addType('sort', 'integer');
		$this->addType('concat', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'collection_id' => (int)$this->collectionId,
			'key' => $this->fieldKey,
			'label' => $this->label,
			'type' => $this->type,
			'options' => $this->options ? json_decode($this->options, true) : null,
			'required' => (bool)$this->required,
			'secret' => (bool)$this->secret,
			'is_title' => (bool)$this->isTitle,
			'list_show' => $this->listShow === null ? true : (bool)$this->listShow,
			'table_show' => $this->tableShow === null ? true : (bool)$this->tableShow,
			'card_show' => $this->cardShow === null ? true : (bool)$this->cardShow,
			'placeholder' => $this->placeholder,
			'sort' => (int)$this->sort,
			'concat' => (int)$this->concat,
			'concat_sep' => $this->concatSep,
			'concat_sep_char' => $this->concatSepChar,
		];
	}
}
