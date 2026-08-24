import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ColaboradoresService, hojeIso } from '../../../../services/colaboradores.service';

@Component({
  selector: 'app-filtros-colaboradores',
  imports: [CommonModule, FormsModule],
  templateUrl: './filtros-colaboradores.html',
  styleUrl: './filtros-colaboradores.css',
})
export class FiltrosColaboradores {
  readonly hoje = hojeIso();

  constructor(public colaboradoresService: ColaboradoresService) {}
}
