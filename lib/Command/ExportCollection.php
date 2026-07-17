<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class ExportCollection extends Base {
	protected function configure(): void {
		$this->setName('regibase:export')
			->setDescription('Export a collection to JSON or CSV (stdout)')
			->addArgument('collection', InputArgument::REQUIRED, 'Collection id or name')
			->addUserOption()
			->addRevealOptions()
			->addOption('format', null, InputOption::VALUE_REQUIRED, 'json (default) or csv', 'json');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$c = $this->resolveCollection($input);
		$key = $this->secretKey($c->getUserId(), $input, $output);
		$fields = $this->fields->findForCollection((int)$c->getId());
		$recs = $this->records->findForCollection((int)$c->getId());
		$format = strtolower((string)$input->getOption('format'));

		if ($format === 'csv') {
			$fh = fopen('php://temp', 'r+');
			fputcsv($fh, array_map(fn ($f) => $f->getLabel(), $fields));
			foreach ($recs as $r) {
				$data = json_decode($r->getData() ?: '{}', true) ?: [];
				$row = [];
				foreach ($fields as $f) {
					$row[] = $this->reveal($key, $data[$f->getFieldKey()] ?? '') ?? '';
				}
				fputcsv($fh, $row);
			}
			rewind($fh);
			$output->write(stream_get_contents($fh));
			fclose($fh);
			return 0;
		}

		if ($format !== 'json') {
			throw new \RuntimeException("Unknown format '$format' (use json or csv)");
		}

		$out = [
			'collection' => [
				'id' => (int)$c->getId(),
				'name' => $c->getName(),
				'icon' => $c->getIcon(),
				'color' => $c->getColor(),
				'description' => $c->getDescription() ?? '',
			],
			'fields' => array_map(fn ($f) => [
				'key' => $f->getFieldKey(),
				'label' => $f->getLabel(),
				'type' => $f->getType(),
				'secret' => (bool)$f->getSecret(),
			], $fields),
			'records' => [],
		];
		foreach ($recs as $r) {
			$data = json_decode($r->getData() ?: '{}', true) ?: [];
			$rowValues = [];
			foreach ($fields as $f) {
				$rowValues[$f->getFieldKey()] = $this->reveal($key, $data[$f->getFieldKey()] ?? '');
			}
			$out['records'][] = [
				'id' => (int)$r->getId(),
				'values' => $rowValues,
				'created_at' => $r->getCreatedAt(),
				'updated_at' => $r->getUpdatedAt(),
			];
		}
		$output->writeln(json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
		return 0;
	}
}
